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
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

const SEED_FILE = path.join(__dirname, 'seed', 'products.json');
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const IS_PROD = process.env.NODE_ENV === 'production';
// Digits-only WhatsApp number (with country code, e.g. 213797009105), so orders go
// straight to this number instead of asking the customer to pick a contact.
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
const MONGODB_URI = process.env.MONGODB_URI || '';

// ---------- MONGODB ATLAS ----------
if (!MONGODB_URI) {
  console.error('⚠️  MONGODB_URI non défini — le catalogue ne pourra pas se connecter à la base de données.');
} else {
  mongoose.connect(MONGODB_URI)
    .then(() => { console.log('MongoDB connecté.'); seedIfEmpty(); })
    .catch(err => console.error('Erreur de connexion MongoDB:', err.message));
}

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  category: { type: String, default: 'Non classé', trim: true },
  brand: { type: String, default: '', trim: true },
  qty: { type: Number, default: 0, min: 0 },
  price: { type: Number, default: 0, min: 0 },
  cost: { type: Number, default: 0, min: 0 },
  unit: { type: String, default: 'U', trim: true },
  image: { type: String, default: null },
  imagePublicId: { type: String, default: null }
}, { versionKey: false });
productSchema.set('toJSON', {
  transform: (doc, ret) => { ret.id = ret._id.toString(); delete ret._id; return ret; }
});
const Product = mongoose.model('Product', productSchema);

// One-time seed from the bundled seed file, only if the Atlas collection is empty
// (e.g. brand-new database). This never overwrites existing data.
async function seedIfEmpty() {
  try {
    const count = await Product.countDocuments();
    if (count === 0 && fs.existsSync(SEED_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
      const docs = raw.map(p => ({
        name: p.name, category: p.category, brand: p.brand || '',
        qty: p.qty || 0, price: p.price || 0, cost: p.cost || 0, unit: p.unit || 'U'
      }));
      if (docs.length) {
        await Product.insertMany(docs);
        console.log('Seedé', docs.length, 'articles dans MongoDB depuis', SEED_FILE);
      }
    }
  } catch (e) {
    console.error('seedIfEmpty error:', e.message);
  }
}

// ---------- CLOUDINARY ----------
if (process.env.CLOUDINARY_URL) {
  cloudinary.config(); // reads CLOUDINARY_URL automatically
} else if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} else {
  console.error('⚠️  CLOUDINARY_URL non défini — l\'envoi de photos produit échouera.');
}
function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'catalogue-produits', resource_type: 'image' },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

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

// ---------- PUBLIC PRODUCT READ (no cost price, no exact qty exposed) ----------
function publicView(p) {
  return { id: p.id, name: p.name, category: p.category, brand: p.brand, price: p.price, unit: p.unit, image: p.image || null, available: p.qty > 0 };
}
app.get('/api/products', async (req, res) => {
  try {
    const list = await Product.find().sort({ name: 1 });
    res.json(list.map(p => publicView(p.toJSON())));
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur (base de données).' });
  }
});

// ---------- ADMIN PRODUCT CRUD ----------
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const list = await Product.find().sort({ name: 1 });
    res.json(list.map(p => p.toJSON()));
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur (base de données).' });
  }
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const { name, category, brand, qty, price, cost, unit } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Le nom est obligatoire.' });
    const p = await Product.create({
      name: String(name).trim(),
      category: category ? String(category).trim() : 'Non classé',
      brand: brand ? String(brand).trim() : '',
      qty: Math.max(0, parseInt(qty) || 0),
      price: Math.max(0, parseFloat(price) || 0),
      cost: Math.max(0, parseFloat(cost) || 0),
      unit: unit ? String(unit).trim() : 'U'
    });
    res.json(p.toJSON());
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur (base de données).' });
  }
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Article introuvable.' });
    const { name, category, brand, qty, price, cost, unit } = req.body || {};
    if (name !== undefined) p.name = String(name).trim();
    if (category !== undefined) p.category = String(category).trim() || 'Non classé';
    if (brand !== undefined) p.brand = String(brand).trim();
    if (qty !== undefined) p.qty = Math.max(0, parseInt(qty) || 0);
    if (price !== undefined) p.price = Math.max(0, parseFloat(price) || 0);
    if (cost !== undefined) p.cost = Math.max(0, parseFloat(cost) || 0);
    if (unit !== undefined) p.unit = String(unit).trim() || 'U';
    await p.save();
    res.json(p.toJSON());
  } catch (e) {
    if (e.name === 'CastError') return res.status(404).json({ error: 'Article introuvable.' });
    res.status(500).json({ error: 'Erreur serveur (base de données).' });
  }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const p = await Product.findByIdAndDelete(req.params.id);
    if (!p) return res.status(404).json({ error: 'Article introuvable.' });
    if (p.imagePublicId) cloudinary.uploader.destroy(p.imagePublicId).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    if (e.name === 'CastError') return res.status(404).json({ error: 'Article introuvable.' });
    res.status(500).json({ error: 'Erreur serveur (base de données).' });
  }
});

// ---------- EXCEL IMPORT ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const HEADER_MAP = {
  id: ['id', 'ref', 'reference'],
  name: ['designation', 'name', 'nom', 'article', 'produit'],
  category: ['categorie', 'category'],
  brand: ['marque', 'brand'],
  qty: ['qte', 'quantite', 'qty', 'stock'],
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
// Two full passes over every column: exact keyword matches are resolved FIRST
// across the whole header row, before any fuzzy/substring fallback runs. This
// stops a loosely-related column (e.g. "Qté Entrée") from stealing the "qty"
// slot away from an exact column named "Qte" that appears later in the row.
function buildFieldIndex(headerRow) {
  const idx = {};
  const norms = headerRow.map(normalizeHeader);
  norms.forEach((norm, i) => {
    if (!norm) return;
    for (const field in HEADER_MAP) {
      if (idx[field] !== undefined) continue;
      if (HEADER_MAP[field].includes(norm)) idx[field] = i;
    }
  });
  norms.forEach((norm, i) => {
    if (!norm) return;
    let bestField = null, bestLen = 0;
    for (const field in HEADER_MAP) {
      if (idx[field] !== undefined) continue;
      for (const kw of HEADER_MAP[field]) {
        if (norm.includes(kw) && kw.length > bestLen) { bestField = field; bestLen = kw.length; }
      }
    }
    if (bestField && idx[bestField] === undefined) idx[bestField] = i;
  });
  return idx;
}
function escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

app.post('/api/admin/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  const mode = req.body.mode === 'merge' ? 'merge' : 'replace';

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'Fichier Excel illisible.' });
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
  try {
    if (mode === 'replace') {
      // Note: this clears all products from the database. Any Cloudinary photos
      // attached to the previous catalogue are not deleted automatically.
      await Product.deleteMany({});
      const created = await Product.insertMany(parsed);
      updated = created.length;
    } else {
      for (const item of parsed) {
        const existing = await Product.findOne({
          name: new RegExp('^' + escapeRegex(item.name) + '$', 'i'),
          brand: new RegExp('^' + escapeRegex(item.brand || '') + '$', 'i')
        });
        if (existing) {
          existing.name = item.name;
          existing.category = item.category;
          existing.brand = item.brand;
          existing.qty = item.qty;
          existing.price = item.price;
          existing.cost = item.cost;
          existing.unit = item.unit;
          await existing.save();
          updated++;
        } else {
          await Product.create(item);
          inserted++;
        }
      }
    }
    const total = await Product.countDocuments();
    res.json({ ok: true, mode, total, inserted, updated });
  } catch (e) {
    res.status(500).json({ error: "Erreur lors de l'import (base de données)." });
  }
});

// ---------- PRODUCT IMAGE UPLOAD (Cloudinary) ----------
function imageFileFilter(req, file, cb) {
  if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) return cb(null, true);
  cb(new Error("Format d'image non supporté (jpg, png, webp ou gif uniquement)."));
}
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFileFilter });

app.post('/api/admin/products/:id/image', requireAdmin, (req, res) => {
  uploadImage.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Erreur lors de l'envoi de l'image." });
    try {
      const p = await Product.findById(req.params.id);
      if (!p) return res.status(404).json({ error: 'Article introuvable.' });
      if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
      const oldPublicId = p.imagePublicId;
      const result = await uploadToCloudinary(req.file.buffer);
      p.image = result.secure_url;
      p.imagePublicId = result.public_id;
      await p.save();
      if (oldPublicId) cloudinary.uploader.destroy(oldPublicId).catch(() => {});
      res.json({ ok: true, image: p.image });
    } catch (e) {
      if (e.name === 'CastError') return res.status(404).json({ error: 'Article introuvable.' });
      res.status(500).json({ error: e.message || "Erreur lors de l'envoi de l'image." });
    }
  });
});

app.delete('/api/admin/products/:id/image', requireAdmin, async (req, res) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Article introuvable.' });
    if (p.imagePublicId) {
      cloudinary.uploader.destroy(p.imagePublicId).catch(() => {});
    }
    p.image = null;
    p.imagePublicId = null;
    await p.save();
    res.json({ ok: true });
  } catch (e) {
    if (e.name === 'CastError') return res.status(404).json({ error: 'Article introuvable.' });
    res.status(500).json({ error: 'Erreur serveur (base de données).' });
  }
});

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
