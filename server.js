const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const INKPATH_API_KEY = process.env.INKPATH_API_KEY || '';
const INKPATH_WEBHOOK_SECRET = process.env.INKPATH_WEBHOOK_SECRET || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SIGNATURES_DIR = path.join(__dirname, 'uploads', 'signatures');
for (const dir of [DATA_DIR, UPLOADS_DIR, SIGNATURES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sender_name TEXT,
    sender_email TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS signature_requests (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    signer_name TEXT NOT NULL,
    signer_email TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    signature_type TEXT,
    signature_data TEXT,
    typed_name TEXT,
    signed_ip TEXT,
    signed_user_agent TEXT,
    signed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id)
  );
`);

function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}
ensureColumn('signature_requests', 'external_ref', 'TEXT');
ensureColumn('signature_requests', 'webhook_url', 'TEXT');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${nanoid()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'image/png', 'image/jpeg'].includes(file.mimetype);
    cb(ok ? null : new Error('Only PDF, PNG, JPEG accepted'), ok);
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function buildSigningUrl(req, token) {
  if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL.replace(/\/$/, '')}/sign/${token}`;
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/sign/${token}`;
}

function requireApiKey(req, res, next) {
  if (!INKPATH_API_KEY) return res.status(503).json({ error: 'INKPATH_API_KEY not configured on the server' });
  const provided = req.headers.authorization || '';
  const expected = `Bearer ${INKPATH_API_KEY}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function fireWebhook(url, payload) {
  if (!url) return;
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'InkPath-Webhook/1.0' };
  if (INKPATH_WEBHOOK_SECRET) {
    const sig = crypto.createHmac('sha256', INKPATH_WEBHOOK_SECRET).update(body).digest('hex');
    headers['X-InkPath-Signature'] = `sha256=${sig}`;
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) console.error(`Webhook to ${url} returned ${res.status}`);
  } catch (err) {
    console.error(`Webhook to ${url} failed: ${err.message}`);
  }
}

app.post('/api/documents', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const { title, signer_name, signer_email, sender_name, sender_email } = req.body;
  if (!signer_name || !signer_email) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'signer_name and signer_email are required' });
  }
  const docId = nanoid();
  const reqId = nanoid();
  const token = nanoid(32);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO documents (id, title, filename, original_name, mime_type, sender_name, sender_email, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(docId, title || req.file.originalname, req.file.filename, req.file.originalname, req.file.mimetype, sender_name || null, sender_email || null, now);
  db.prepare(`
    INSERT INTO signature_requests (id, document_id, signer_name, signer_email, token, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(reqId, docId, signer_name, signer_email, token, now);
  res.json({
    request_id: reqId,
    document_id: docId,
    token,
    signing_url: buildSigningUrl(req, token)
  });
});

app.post('/api/v1/documents', requireApiKey, (req, res) => {
  const {
    title, filename, mime_type, content_base64,
    signer_name, signer_email, sender_name, sender_email,
    external_ref, webhook_url
  } = req.body || {};
  if (!filename || !mime_type || !content_base64) {
    return res.status(400).json({ error: 'filename, mime_type, content_base64 required' });
  }
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(mime_type)) {
    return res.status(400).json({ error: 'mime_type must be application/pdf, image/png, or image/jpeg' });
  }
  if (!signer_name || !signer_email) {
    return res.status(400).json({ error: 'signer_name and signer_email required' });
  }
  const buf = Buffer.from(content_base64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'content_base64 is empty or invalid' });
  if (buf.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'file exceeds 25MB' });

  const ext = mime_type === 'application/pdf' ? '.pdf' : mime_type === 'image/png' ? '.png' : '.jpg';
  const storedName = `${nanoid()}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buf);

  const docId = nanoid();
  const reqId = nanoid();
  const token = nanoid(32);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO documents (id, title, filename, original_name, mime_type, sender_name, sender_email, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(docId, title || filename, storedName, filename, mime_type, sender_name || null, sender_email || null, now);
  db.prepare(`
    INSERT INTO signature_requests
      (id, document_id, signer_name, signer_email, token, status, external_ref, webhook_url, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(reqId, docId, signer_name, signer_email, token, external_ref || null, webhook_url || null, now);

  res.json({
    request_id: reqId,
    document_id: docId,
    token,
    signing_url: buildSigningUrl(req, token),
    external_ref: external_ref || null
  });
});

app.get('/api/documents', (req, res) => {
  const rows = db.prepare(`
    SELECT d.id AS document_id, d.title, d.original_name, d.created_at,
           r.id AS request_id, r.signer_name, r.signer_email, r.status, r.signed_at, r.signed_ip, r.token
    FROM documents d
    JOIN signature_requests r ON r.document_id = d.id
    ORDER BY d.created_at DESC
  `).all();
  res.json(rows.map(r => ({ ...r, signing_url: `${req.protocol}://${req.get('host')}/sign/${r.token}` })));
});

app.get('/api/requests/:token', (req, res) => {
  const row = db.prepare(`
    SELECT r.*, d.title, d.original_name, d.mime_type, d.filename
    FROM signature_requests r
    JOIN documents d ON d.id = r.document_id
    WHERE r.token = ?
  `).get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    request_id: row.id,
    status: row.status,
    signer_name: row.signer_name,
    signer_email: row.signer_email,
    document: {
      title: row.title,
      original_name: row.original_name,
      mime_type: row.mime_type,
      url: `/files/${row.filename}`
    },
    signed_at: row.signed_at,
    signed_ip: row.signed_ip,
    signature_type: row.signature_type,
    typed_name: row.typed_name,
    signature_data: row.signature_data
  });
});

app.post('/api/requests/:token/sign', async (req, res) => {
  const { signature_type, signature_data, typed_name } = req.body || {};
  if (!['drawn', 'typed'].includes(signature_type)) {
    return res.status(400).json({ error: 'signature_type must be "drawn" or "typed"' });
  }
  if (signature_type === 'drawn' && !signature_data) {
    return res.status(400).json({ error: 'signature_data required for drawn signature' });
  }
  if (signature_type === 'typed' && !typed_name) {
    return res.status(400).json({ error: 'typed_name required for typed signature' });
  }
  const row = db.prepare(`SELECT * FROM signature_requests WHERE token = ?`).get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status === 'signed') return res.status(409).json({ error: 'Already signed' });

  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const signedAt = new Date().toISOString();

  let storedSignatureData = signature_data || null;
  if (signature_type === 'drawn' && signature_data && signature_data.startsWith('data:image/')) {
    const match = signature_data.match(/^data:image\/(png|jpeg);base64,(.+)$/);
    if (match) {
      const ext = match[1] === 'jpeg' ? 'jpg' : 'png';
      const filename = `${row.id}.${ext}`;
      fs.writeFileSync(path.join(SIGNATURES_DIR, filename), Buffer.from(match[2], 'base64'));
      storedSignatureData = `/signatures/${filename}`;
    }
  }

  db.prepare(`
    UPDATE signature_requests
    SET status = 'signed', signature_type = ?, signature_data = ?, typed_name = ?,
        signed_ip = ?, signed_user_agent = ?, signed_at = ?
    WHERE token = ?
  `).run(signature_type, storedSignatureData, typed_name || null, ip, ua, signedAt, req.params.token);

  res.json({
    status: 'signed',
    signed_at: signedAt,
    signed_ip: ip,
    signature_type,
    signature_data: storedSignatureData,
    typed_name: typed_name || null
  });

  if (row.webhook_url) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    fireWebhook(row.webhook_url, {
      event: 'signature.signed',
      request_id: row.id,
      token: row.token,
      external_ref: row.external_ref,
      status: 'signed',
      signed_at: signedAt,
      signed_ip: ip,
      signed_user_agent: ua,
      signature_type,
      typed_name: typed_name || null,
      signature_url: storedSignatureData && storedSignatureData.startsWith('/signatures/')
        ? `${PUBLIC_BASE_URL ? PUBLIC_BASE_URL.replace(/\/$/, '') : `${proto}://${host}`}${storedSignatureData}`
        : null
    });
  }
});

app.get('/files/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, safe);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

app.get('/signatures/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const filePath = path.join(SIGNATURES_DIR, safe);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

app.get('/sign/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`E-sign app running on http://localhost:${PORT}`);
});
