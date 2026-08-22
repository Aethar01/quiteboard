# Quiteboard

Quiteboard is a lightweight, self-hosted collaborative whiteboard focused on annotating images and multi-page PDFs.

## Version 1

Current v1 features:

- Persistent boards
- Real-time collaboration over Socket.IO
- Live remote cursors and presence
- Pen and highlighter
- Eraser
- Text and rectangles
- Select and move objects
- Pan and zoom
- Image upload
- Multi-page PDF import
- PDF pages rendered to JPEG and stacked top-to-bottom
- Imported PDF pages locked by default so annotations remain separate
- Lock/unlock objects
- Docker deployment
- Local filesystem persistence

Quiteboard intentionally does not generate server-side whiteboard thumbnails and does not run Chromium/Puppeteer.

## Quick start with Docker Compose

```bash
git clone https://github.com/Aethar01/quiteboard.git
cd quiteboard
docker compose up -d --build
```

Open:

```text
http://YOUR-SERVER-IP:9680
```

Persistent data is stored in:

```text
./data/
├── assets/
└── boards/
```

## TrueNAS SCALE

A convenient dataset layout is:

```text
/mnt/NVME1/quiteboard/
├── source/
└── data/
```

Clone the repository:

```bash
git clone https://github.com/Aethar01/quiteboard.git /mnt/NVME1/quiteboard/source
mkdir -p /mnt/NVME1/quiteboard/data
```

For a TrueNAS Custom App, use:

```yaml
services:
  quiteboard:
    build:
      context: /mnt/NVME1/quiteboard/source
    container_name: quiteboard
    restart: unless-stopped
    ports:
      - "9680:3000"
    environment:
      PORT: "3000"
      DATA_DIR: /app/data
      MAX_UPLOAD_MB: "50"
    volumes:
      - /mnt/NVME1/quiteboard/data:/app/data
```

Then route your reverse proxy or Cloudflare Tunnel to:

```text
http://TRUENAS-LAN-IP:9680
```

Socket.IO uses the same HTTP origin, so no separate collaboration hostname is required.

## PDF workflow

Choose **PDF** from the toolbar. Quiteboard uses Mozilla PDF.js in the browser to render every page, uploads each rendered page as a JPEG asset, and places them vertically in document order.

PDF pages are locked by default. This prevents accidental movement while drawing over them. Select a page and use **Lock/Unlock** if you need to reposition it.

The current PDF render scale is `2`, with JPEG quality `0.92`. These values can be adjusted in `public/app.js`.

## Storage

Board metadata and object state are JSON files under `/app/data/boards`. Uploaded images and rendered PDF pages are stored under `/app/data/assets`.

This is deliberately simple for v1. Backing up the `/app/data` volume backs up the boards and their assets.

## Security

Version 1 does **not** include authentication or per-board access control. Do not expose it directly to the public internet without an access layer such as Cloudflare Access, an authenticated reverse proxy, VPN, or equivalent protection.

## Collaboration model

Quiteboard synchronizes objects individually rather than repeatedly sending the entire board. Persistent object create/update/delete operations are stored server-side, while cursors and presence are transient.

This is suitable for the initial version, but it is not yet a CRDT. Simultaneous edits to the exact same object are last-write-wins. A future version can move the object store to Yjs while retaining the current UI and asset model.

## Keyboard shortcuts

- `V`: select
- `P`: pen
- `H`: highlighter
- `Delete` / `Backspace`: delete selected unlocked object
- Mouse wheel: zoom
- Alt-drag or middle-button drag: pan

## Development

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## License

No license has been selected yet.
