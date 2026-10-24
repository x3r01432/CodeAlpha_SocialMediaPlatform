const express = require('express');
const path = require('path');
const { openDb } = require('./db');
const { hash, check, sign, requireAuth, validCreds, verify } = require('./auth');

const AVATARS = ['🙂', '😎', '🦊', '🐼', '🐯', '🦄', '🐙', '🌵', '🚀', '🎸', '⚽', '🎨'];

function createApp({ dbFile } = {}) {
  const db = openDb(dbFile);
  const app = express();
  app.use(express.json({ limit: '50kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // optional auth: lets public endpoints know who is looking (for "liked by me" / "following")
  const viewer = (req) => { try { return verify((req.headers.authorization || '').slice(7)).id; } catch { return 0; } };
  const pub = (u) => u && ({ id: u.id, username: u.username, display_name: u.display_name, bio: u.bio, avatar: u.avatar, created_at: u.created_at });

  const POST_SQL = `SELECT p.*, u.username, u.display_name, u.avatar,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
      EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = @me) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id`;

  app.post('/api/register', (req, res) => {
    const v = validCreds(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(v.u)) return res.status(409).json({ error: 'Username taken' });
    const avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
    const r = db.prepare('INSERT INTO users (username, password_hash, display_name, avatar) VALUES (?,?,?,?)').run(v.u, hash(v.p), v.u, avatar);
    const user = pub(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid));
    res.status(201).json({ token: sign(user), user });
  });
  app.post('/api/login', (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body?.username || ''));
    if (!row || !check(String(req.body?.password || ''), row.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
    res.json({ token: sign(row), user: pub(row) });
  });

  // ---------- profiles ----------
  app.get('/api/avatars', (_req, res) => res.json(AVATARS));
  app.get('/api/users', (req, res) => {
    const me = viewer(req);
    const q = `%${String(req.query.q || '')}%`;
    const rows = db.prepare(`SELECT u.*, EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id) following
      FROM users u WHERE (u.username LIKE ? OR u.display_name LIKE ?) AND u.id <> ? ORDER BY u.username LIMIT 50`).all(me, q, q, me);
    res.json(rows.map((u) => ({ ...pub(u), following: !!u.following })));
  });
  app.get('/api/users/:username', (req, res) => {
    const me = viewer(req);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const c = (sql) => db.prepare(sql).get(u.id).n;
    res.json({
      ...pub(u),
      followers: c('SELECT COUNT(*) n FROM follows WHERE following_id = ?'),
      following_count: c('SELECT COUNT(*) n FROM follows WHERE follower_id = ?'),
      post_count: c('SELECT COUNT(*) n FROM posts WHERE user_id = ?'),
      is_following: !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(me, u.id),
      posts: db.prepare(`${POST_SQL} WHERE p.user_id = @uid ORDER BY p.id DESC`).all({ me, uid: u.id }).map(fix),
    });
  });
  app.put('/api/me', requireAuth, (req, res) => {
    const display = String(req.body?.display_name ?? '').trim().slice(0, 40);
    const bio = String(req.body?.bio ?? '').trim().slice(0, 160);
    const avatar = AVATARS.includes(req.body?.avatar) ? req.body.avatar : undefined;
    const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET display_name = ?, bio = ?, avatar = ? WHERE id = ?').run(display || cur.username, bio, avatar || cur.avatar, req.user.id);
    res.json(pub(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  // ---------- follows ----------
  app.post('/api/users/:username/follow', requireAuth, (req, res) => {
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.id === req.user.id) return res.status(400).json({ error: "You can't follow yourself" });
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.user.id, u.id);
    res.json({ following: true });
  });
  app.delete('/api/users/:username/follow', requireAuth, (req, res) => {
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    if (!u) return res.status(404).json({ error: 'User not found' });
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user.id, u.id);
    res.json({ following: false });
  });

  // ---------- posts ----------
  const fix = (p) => ({ ...p, liked: !!p.liked });
  app.post('/api/posts', requireAuth, (req, res) => {
    const content = String(req.body?.content || '').trim();
    if (!content || content.length > 500) return res.status(400).json({ error: 'Post must be 1-500 characters' });
    const r = db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(req.user.id, content);
    res.status(201).json(fix(db.prepare(`${POST_SQL} WHERE p.id = @id`).get({ me: req.user.id, id: r.lastInsertRowid })));
  });
  app.delete('/api/posts/:id', requireAuth, (req, res) => {
    const r = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!r.changes) return res.status(404).json({ error: 'Post not found or not yours' });
    res.json({ ok: true });
  });
  // feed: my posts + posts of people I follow
  app.get('/api/feed', requireAuth, (req, res) => {
    res.json(db.prepare(`${POST_SQL} WHERE p.user_id = @me OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = @me) ORDER BY p.id DESC LIMIT 100`).all({ me: req.user.id }).map(fix));
  });
  app.get('/api/explore', (req, res) => {
    res.json(db.prepare(`${POST_SQL} ORDER BY p.id DESC LIMIT 100`).all({ me: viewer(req) }).map(fix));
  });

  // ---------- likes ----------
  const postExists = (id) => db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id);
  app.post('/api/posts/:id/like', requireAuth, (req, res) => {
    if (!postExists(req.params.id)) return res.status(404).json({ error: 'Post not found' });
    db.prepare('INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)').run(req.params.id, req.user.id);
    res.json({ liked: true, like_count: db.prepare('SELECT COUNT(*) n FROM likes WHERE post_id = ?').get(req.params.id).n });
  });
  app.delete('/api/posts/:id/like', requireAuth, (req, res) => {
    db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ liked: false, like_count: db.prepare('SELECT COUNT(*) n FROM likes WHERE post_id = ?').get(req.params.id).n });
  });

  // ---------- comments ----------
  app.get('/api/posts/:id/comments', (req, res) => {
    res.json(db.prepare('SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON u.id = c.user_id WHERE post_id = ? ORDER BY c.id').all(req.params.id));
  });
  app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
    if (!postExists(req.params.id)) return res.status(404).json({ error: 'Post not found' });
    const content = String(req.body?.content || '').trim();
    if (!content || content.length > 300) return res.status(400).json({ error: 'Comment must be 1-300 characters' });
    const r = db.prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?,?,?)').run(req.params.id, req.user.id, content);
    res.status(201).json(db.prepare('SELECT c.*, u.username, u.display_name, u.avatar FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(r.lastInsertRowid));
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.locals.db = db;
  return app;
}
module.exports = { createApp };
