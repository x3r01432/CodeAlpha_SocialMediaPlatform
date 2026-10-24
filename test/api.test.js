const { test, before } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../src/app');

let app; const T = {};
const as = (u) => ({ Authorization: `Bearer ${T[u]}` });
before(async () => {
  app = createApp({ dbFile: ':memory:' });
  for (const u of ['alice', 'bob', 'carol']) T[u] = (await request(app).post('/api/register').send({ username: u, password: 'password1' })).body.token;
});

test('register/login with hashed password', async () => {
  assert.strictEqual((await request(app).post('/api/login').send({ username: 'alice', password: 'password1' })).status, 200);
  assert.strictEqual((await request(app).post('/api/login').send({ username: 'alice', password: 'bad' })).status, 401);
  assert.match(app.locals.db.prepare("SELECT password_hash h FROM users WHERE username='alice'").get().h, /^\$2/);
});
test('update profile bio and avatar', async () => {
  const r = await request(app).put('/api/me').set(as('alice')).send({ display_name: 'Alice A.', bio: 'Coffee & code', avatar: '🦊' });
  assert.strictEqual(r.body.bio, 'Coffee & code');
  assert.strictEqual(r.body.avatar, '🦊');
  const p = await request(app).get('/api/users/alice');
  assert.strictEqual(p.body.display_name, 'Alice A.');
});
test('create post validates content', async () => {
  assert.strictEqual((await request(app).post('/api/posts').set(as('bob')).send({ content: '' })).status, 400);
  assert.strictEqual((await request(app).post('/api/posts').send({ content: 'hi' })).status, 401);
  assert.strictEqual((await request(app).post('/api/posts').set(as('bob')).send({ content: 'Hello from Bob' })).status, 201);
  await request(app).post('/api/posts').set(as('carol')).send({ content: 'Carol here' });
});
test('feed shows only own + followed users posts', async () => {
  let f = await request(app).get('/api/feed').set(as('alice'));
  assert.strictEqual(f.body.length, 0);
  assert.strictEqual((await request(app).post('/api/users/bob/follow').set(as('alice'))).body.following, true);
  f = await request(app).get('/api/feed').set(as('alice'));
  assert.deepStrictEqual(f.body.map((p) => p.username), ['bob']);
});
test('follower counts and unfollow', async () => {
  let p = await request(app).get('/api/users/bob').set(as('alice'));
  assert.strictEqual(p.body.followers, 1);
  assert.strictEqual(p.body.is_following, true);
  await request(app).delete('/api/users/bob/follow').set(as('alice'));
  p = await request(app).get('/api/users/bob').set(as('alice'));
  assert.strictEqual(p.body.followers, 0);
  assert.strictEqual((await request(app).post('/api/users/alice/follow').set(as('alice'))).status, 400);
});
test('like is idempotent and can be removed', async () => {
  const id = (await request(app).get('/api/explore')).body.find((p) => p.username === 'bob').id;
  await request(app).post(`/api/posts/${id}/like`).set(as('alice'));
  const r = await request(app).post(`/api/posts/${id}/like`).set(as('alice'));
  assert.strictEqual(r.body.like_count, 1);
  const e = (await request(app).get('/api/explore').set(as('alice'))).body.find((p) => p.id === id);
  assert.strictEqual(e.liked, true);
  assert.strictEqual((await request(app).delete(`/api/posts/${id}/like`).set(as('alice'))).body.like_count, 0);
});
test('comments are added and listed', async () => {
  const id = (await request(app).get('/api/explore')).body.find((p) => p.username === 'bob').id;
  assert.strictEqual((await request(app).post(`/api/posts/${id}/comments`).set(as('carol')).send({ content: 'Nice!' })).status, 201);
  const c = await request(app).get(`/api/posts/${id}/comments`);
  assert.strictEqual(c.body[0].username, 'carol');
});
test('only the author can delete a post', async () => {
  const id = (await request(app).get('/api/explore')).body.find((p) => p.username === 'bob').id;
  assert.strictEqual((await request(app).delete(`/api/posts/${id}`).set(as('alice'))).status, 404);
  assert.strictEqual((await request(app).delete(`/api/posts/${id}`).set(as('bob'))).status, 200);
});
test('user search excludes self', async () => {
  const r = await request(app).get('/api/users?q=').set(as('alice'));
  assert.ok(!r.body.some((u) => u.username === 'alice'));
  assert.strictEqual(r.body.length, 2);
});
