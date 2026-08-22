import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BOARDS_DIR = path.join(DATA_DIR, 'boards');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');

for (const dir of [DATA_DIR, BOARDS_DIR, ASSETS_DIR]) fs.mkdirSync(dir, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 20 * 1024 * 1024
});

app.use(express.json({ limit: '4mb' }));
app.use('/assets', express.static(ASSETS_DIR, { maxAge: '7d' }));
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build')));
app.use(express.static(path.join(__dirname, 'public')));

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function boardPath(id) {
  return path.join(BOARDS_DIR, `${safeId(id)}.json`);
}

function readBoard(id) {
  const file = boardPath(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeBoard(board) {
  board.updatedAt = new Date().toISOString();
  const file = boardPath(board.id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, file);
}

function listBoards() {
  return fs.readdirSync(BOARDS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        const board = JSON.parse(fs.readFileSync(path.join(BOARDS_DIR, name), 'utf8'));
        return { id: board.id, name: board.name, createdAt: board.createdAt, updatedAt: board.updatedAt };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

app.get('/api/health', (req, res) => res.json({ ok: true, version: '0.1.0' }));

app.get('/api/boards', (req, res) => res.json(listBoards()));

app.post('/api/boards', (req, res) => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const board = {
    id,
    name: String(req.body?.name || 'Untitled board').slice(0, 120),
    createdAt: now,
    updatedAt: now,
    objects: []
  };
  writeBoard(board);
  res.status(201).json(board);
});

app.get('/api/boards/:id', (req, res) => {
  const board = readBoard(req.params.id);
  if (!board) return res.sendStatus(404);
  res.json(board);
});

app.patch('/api/boards/:id', (req, res) => {
  const board = readBoard(req.params.id);
  if (!board) return res.sendStatus(404);
  if (typeof req.body?.name === 'string') board.name = req.body.name.slice(0, 120);
  writeBoard(board);
  io.to(`board:${board.id}`).emit('board:meta', { name: board.name, updatedAt: board.updatedAt });
  res.json(board);
});

app.delete('/api/boards/:id', (req, res) => {
  const file = boardPath(req.params.id);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  fs.unlinkSync(file);
  res.sendStatus(204);
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ASSETS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024 }
});

app.post('/api/assets', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  res.status(201).json({
    url: `/assets/${req.file.filename}`,
    name: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size
  });
});

const presence = new Map();

function roomUsers(boardId) {
  const users = [];
  for (const value of presence.values()) if (value.boardId === boardId) users.push(value.user);
  return users;
}

function persistObject(boardId, object) {
  const board = readBoard(boardId);
  if (!board) return null;
  const index = board.objects.findIndex((item) => item.id === object.id);
  if (index >= 0) board.objects[index] = object;
  else board.objects.push(object);
  writeBoard(board);
  return board;
}

function removeObject(boardId, objectId) {
  const board = readBoard(boardId);
  if (!board) return null;
  board.objects = board.objects.filter((item) => item.id !== objectId);
  writeBoard(board);
  return board;
}

io.on('connection', (socket) => {
  socket.on('board:join', ({ boardId, user }) => {
    boardId = safeId(boardId);
    const board = readBoard(boardId);
    if (!board) return socket.emit('board:error', 'Board not found');

    const cleanUser = {
      id: socket.id,
      name: String(user?.name || 'Guest').slice(0, 40),
      color: String(user?.color || '#4f46e5').slice(0, 20)
    };

    socket.join(`board:${boardId}`);
    presence.set(socket.id, { boardId, user: cleanUser });
    socket.emit('board:snapshot', board);
    io.to(`board:${boardId}`).emit('presence', roomUsers(boardId));
  });

  socket.on('object:upsert', ({ boardId, object }) => {
    boardId = safeId(boardId);
    if (!object || typeof object.id !== 'string') return;
    const board = persistObject(boardId, object);
    if (!board) return;
    socket.to(`board:${boardId}`).emit('object:upsert', object);
  });

  socket.on('object:remove', ({ boardId, objectId }) => {
    boardId = safeId(boardId);
    if (!objectId) return;
    const board = removeObject(boardId, objectId);
    if (!board) return;
    socket.to(`board:${boardId}`).emit('object:remove', objectId);
  });

  socket.on('cursor', ({ boardId, x, y }) => {
    const info = presence.get(socket.id);
    boardId = safeId(boardId);
    if (!info || info.boardId !== boardId) return;
    socket.to(`board:${boardId}`).emit('cursor', {
      user: info.user,
      x: Number(x) || 0,
      y: Number(y) || 0
    });
  });

  socket.on('disconnect', () => {
    const info = presence.get(socket.id);
    presence.delete(socket.id);
    if (info) io.to(`board:${info.boardId}`).emit('presence', roomUsers(info.boardId));
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Quiteboard listening on http://0.0.0.0:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
