require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const XLSX = require('xlsx');

const DATA_FILE = path.join(__dirname, 'data', 'products.json');
const SEED_FILE = path.join(__dirname, 'seed', 'products.json');
const IMAGES_DIR = path.join(__dirname, 'data', 'images');
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const IS_PROD = process.env.NODE_ENV === 'production';
// Digits-only WhatsApp number (with country code, e.g. 213797009105), so orders go
// straight to this number instead of asking the customer to pick a contact.
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');

// If a persistent disk is mounted at data/ and is empty (fresh disk on first deploy),
// seed it once from the bundled seed copy so the catalogue isn't blank.
function ensureDataFile() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE) && fs.existsSync(SEED_FILE)) {
      fs.copyFileSync(SEED_FILE, DATA_FILE);
      console.log('Seeded', DATA_FILE, 'from', SEED_FILE);
    }
  } catch (e) {
    console.error('ensureDataFile error:', e.message);
  }
}
ensureDataFile();

// ---------- DATA LAYER (simple JSON file, atomic-ish writes) ----------
function loadProducts() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}
function saveProducts(products) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(products), 'utf-8');
  fs.renameSync(tmp, DATA_FILE);
}
let products = loadProducts();
let nextId = products.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;

// ---------- APP SETUP ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: SESSION_SECRET,
  name: 'catalogue.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 1000 * 60 * 60 * 12 // 12h
  }
}));

// ---------- LOGIN RATE LIMITING (simple in-memory) ----------
const loginAttempts = new Map(); // ip -> {count, resetAt}
function isRateLimited(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { loginAttempts.delete(ip); return false; }
  return rec.count >= 8;
}
function registerFailedAttempt(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  rec.count += 1;
  loginAttempts.set(ip, rec);
}
function clearAttempts(ip) { loginAttempts.delete(ip); }

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // still run a compare to keep timing roughly constant
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Authentification admin requise.' });
}

// ---------- AUTH ROUTES ----------
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  }
  const { username, password } = req.body || {};
  const okUser = timingSafeEqual(username || '', ADMIN_USERNAME);
  const okPass = timingSafeEqual(password || '', ADMIN_PASSWORD);
  if (okUser && okPass) {
    clearAttempts(ip);
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  registerFailedAttempt(ip);
  return res.status(401).json({ error: 'Identifiants incorrects.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

app.get('/api/config', (req, res) => {
  res.json({ whatsappNumber: WHATSAPP_NUMBER });
});

// ---------- PUBLIC PRODUCT READ (no cost price exposed) ----------
function publicView(p) {
  return { id: p.id, name: p.name, category: p.category, brand: p.brand, price: p.price, unit: p.unit, image: p.image || null, available: p.qty > 0 };
}
app.get('/api/products', (req, res) => {
  res.json(products.map(publicView));
});

// ---------- ADMIN PRODUCT CRUD ----------
app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(products);
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { name, category, brand, qty, price, cost, unit } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Le nom est obligatoire.' });
  const p = {
    id: nextId++,
    name: String(name).trim(),
    category: category ? String(category).trim() : 'Non classé',
    brand: brand ? String(brand).trim() : '',
    qty: Math.max(0, parseInt(qty) || 0),
    price: Math.max(0, parseFloat(price) || 0),
    cost: Math.max(0, parseFloat(cost) || 0),
    unit: unit ? String(unit).trim() : 'U',
    image: null
  };
  products.push(p);
  saveProducts(products);
  res.json(p);
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const p = products.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: 'Article introuvable.' });
  const { name, category, brand, qty, price, cost, unit } = req.body || {};
  if (name !== undefined) p.name = String(name).trim();
  if (category !== undefined) p.category = String(category).trim() || 'Non classé';
  if (brand !== undefined) p.brand = String(brand).trim();
  if (qty !== undefined) p.qty = Math.max(0, parseInt(qty) || 0);
  if (price !== undefined) p.price = Math.max(0, parseFloat(price) || 0);
  if (cost !== undefined) p.cost = Math.max(0, parseFloat(cost) || 0);
  if (unit !== undefined) p.unit = String(unit).trim() || 'U';
  saveProducts(products);
  res.json(p);
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const existing = products.find(x => x.id === id);
  const before = products.length;
  products = products.filter(x => x.id !== id);
  if (products.length === before) return res.status(404).json({ error: 'Article introuvable.' });
  if (existing && existing.image) {
    fs.unlink(path.join(IMAGES_DIR, path.basename(existing.image)), () => {});
  }
  saveProducts(products);
  res.json({ ok: true });
});

// ---------- EXCEL IMPORT ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const HEADER_MAP = {
  id: ['id', 'ref', 'reference'],
  name: ['designation', 'name', 'nom', 'article', 'produit'],
  category: ['categorie', 'category'],
  brand: ['marque', 'brand'],
  qty: ['quantite', 'qty', 'stock', 'qte'],
  cost: ['achat', 'cout', 'cost'],
  price: ['vente', 'price', 'prix'],
  unit: ['unite', 'unit']
};
function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeHeader(h) {
  return stripAccents(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function buildFieldIndex(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const norm = normalizeHeader(h);
    if (!norm) return;
    // Exact match against a known keyword wins outright.
    for (const field in HEADER_MAP) {
      if (idx[field] !== undefined) continue;
      if (HEADER_MAP[field].includes(norm)) { idx[field] = i; return; }
    }
    // Otherwise, best (longest) keyword found anywhere in the header text —
    // this catches real-world variants like "Qté", "Quantité en stock",
    // "Prix d'achat (DA)", etc. that don't match a column name exactly.
    let bestField = null, bestLen = 0;
    for (const field in HEADER_MAP) {
      if (idx[field] !== undefined) continue;
      for (const kw of HEADER_MAP[field]) {
        if (norm.includes(kw) && kw.length > bestLen) { bestField = field; bestLen = kw.length; }
      }
    }
    if (bestField) idx[bestField] = i;
  });
  return idx;
}

app.post('/api/admin/import', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  const mode = req.body.mode === 'merge' ? 'merge' : 'replace';

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: "Fichier Excel illisible." });
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (!rows.length) return res.status(400).json({ error: 'Le fichier est vide.' });

  const fieldIdx = buildFieldIndex(rows[0]);
  if (fieldIdx.name === undefined) {
    return res.status(400).json({ error: "Colonne 'nom / désignation' introuvable. Vérifiez l'en-tête du fichier." });
  }

  const parsed = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;
    const name = fieldIdx.name !== undefined ? String(row[fieldIdx.name] || '').trim() : '';
    if (!name) continue;
    parsed.push({
      id: fieldIdx.id !== undefined && row[fieldIdx.id] !== '' ? parseInt(row[fieldIdx.id]) : undefined,
      name,
      category: fieldIdx.category !== undefined ? String(row[fieldIdx.category] || 'Non classé').trim() || 'Non classé' : 'Non classé',
      brand: fieldIdx.brand !== undefined ? String(row[fieldIdx.brand] || '').trim() : '',
      qty: fieldIdx.qty !== undefined ? Math.max(0, parseInt(row[fieldIdx.qty]) || 0) : 0,
      price: fieldIdx.price !== undefined ? Math.max(0, parseFloat(row[fieldIdx.price]) || 0) : 0,
      cost: fieldIdx.cost !== undefined ? Math.max(0, parseFloat(row[fieldIdx.cost]) || 0) : 0,
      unit: fieldIdx.unit !== undefined ? String(row[fieldIdx.unit] || 'U').trim() || 'U' : 'U'
    });
  }

  if (!parsed.length) return res.status(400).json({ error: 'Aucune ligne exploitable trouvée dans le fichier.' });

  let inserted = 0, updated = 0;

  if (mode === 'replace') {
    const result = [];
    parsed.forEach(item => {
      const id = item.id && Number.isFinite(item.id) ? item.id : nextId++;
      if (item.id && Number.isFinite(item.id)) nextId = Math.max(nextId, id + 1);
      result.push({ id, name: item.name, category: item.category, brand: item.brand, qty: item.qty, price: item.price, cost: item.cost, unit: item.unit });
      updated++;
    });
    products = result;
  } else {
    parsed.forEach(item => {
      let existing = null;
      if (item.id && Number.isFinite(item.id)) existing = products.find(p => p.id === item.id);
      if (!existing) existing = products.find(p => p.name.toLowerCase() === item.name.toLowerCase() && (p.brand || '').toLowerCase() === (item.brand || '').toLowerCase());
      if (existing) {
        Object.assign(existing, { name: item.name, category: item.category, brand: item.brand, qty: item.qty, price: item.price, cost: item.cost, unit: item.unit });
        updated++;
      } else {
        const id = nextId++;
        products.push({ id, name: item.name, category: item.category, brand: item.brand, qty: item.qty, price: item.price, cost: item.cost, unit: item.unit });
        inserted++;
      }
    });
  }

  saveProducts(products);
  res.json({ ok: true, mode, total: products.length, inserted, updated });
});

// ---------- PRODUCT IMAGE UPLOAD ----------
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMAGES_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
    cb(null, 'product-' + req.params.id + '-' + Date.now() + safeExt);
  }
});
function imageFileFilter(req, file, cb) {
  if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) return cb(null, true);
  cb(new Error("Format d'image non supporté (jpg, png, webp ou gif uniquement)."));
}
const uploadImage = multer({ storage: imageStorage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFileFilter });

app.post('/api/admin/products/:id/image', requireAdmin, (req, res) => {
  uploadImage.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "Erreur lors de l'envoi de l'image." });
    const id = parseInt(req.params.id);
    const p = products.find(x => x.id === id);
    if (!p) return res.status(404).json({ error: 'Article introuvable.' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
    if (p.image) {
      fs.unlink(path.join(IMAGES_DIR, path.basename(p.image)), () => {});
    }
    p.image = '/product-images/' + req.file.filename;
    saveProducts(products);
    res.json({ ok: true, image: p.image });
  });
});

app.delete('/api/admin/products/:id/image', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const p = products.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: 'Article introuvable.' });
  if (p.image) {
    fs.unlink(path.join(IMAGES_DIR, path.basename(p.image)), () => {});
    p.image = null;
    saveProducts(products);
  }
  res.json({ ok: true });
});

app.use('/product-images', express.static(IMAGES_DIR));

// ---------- STATIC FRONTEND ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Catalogue server running on port ${PORT}`);
  if (ADMIN_PASSWORD === 'changeme123') {
    console.warn('⚠️  ADMIN_PASSWORD non défini — mot de passe par défaut utilisé. Changez-le avant la mise en production !');
  }
});
