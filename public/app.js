const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const session = () => JSON.parse(localStorage.getItem('circle_session') || 'null');
const ago = (ts) => { const s = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
async function api(path, opts = {}) {
  const s = session();
  const res = await fetch('/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(s ? { Authorization: 'Bearer ' + s.token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function header() {
  const s = session();
  $('#who').innerHTML = s ? `<a href="#/u/${esc(s.user.username)}" class="row" style="gap:6px"><span class="av" style="width:30px;height:30px;font-size:16px">${s.user.avatar}</span>@${esc(s.user.username)}</a> <a href="#" id="lo">Log out</a>` : '';
  if (s) $('#lo').onclick = (e) => { e.preventDefault(); localStorage.removeItem('circle_session'); route(); };
}
function postHtml(p) {
  const me = session()?.user;
  return `<div class="card post" data-id="${p.id}"><div class="row"><a href="#/u/${esc(p.username)}" class="av">${p.avatar}</a><div><a href="#/u/${esc(p.username)}"><b>${esc(p.display_name)}</b></a> <span class="muted">@${esc(p.username)} · ${ago(p.created_at)}</span></div>${me && me.id === p.user_id ? '<button class="btn danger" data-del style="margin-left:auto;padding:4px 10px">Delete</button>' : ''}</div>
  <div class="content">${esc(p.content)}</div>
  <div class="actions"><button data-like class="${p.liked ? 'liked' : ''}">${p.liked ? '❤️' : '🤍'} <span>${p.like_count}</span></button><button data-cm>💬 <span>${p.comment_count}</span></button></div>
  <div class="comments" hidden></div></div>`;
}
function wirePosts(root, reload) {
  root.querySelectorAll('.post').forEach((el) => {
    const id = el.dataset.id;
    $('[data-like]', el).onclick = async (e) => {
      if (!session()) return (location.hash = '#/login');
      const b = e.currentTarget; const liked = b.classList.contains('liked');
      const r = await api(`/posts/${id}/like`, { method: liked ? 'DELETE' : 'POST' });
      b.classList.toggle('liked', r.liked); b.innerHTML = `${r.liked ? '❤️' : '🤍'} <span>${r.like_count}</span>`;
    };
    const del = $('[data-del]', el); if (del) del.onclick = async () => { if (confirm('Delete this post?')) { await api('/posts/' + id, { method: 'DELETE' }); reload(); } };
    $('[data-cm]', el).onclick = async () => {
      const box = $('.comments', el); box.hidden = !box.hidden; if (box.hidden) return;
      const draw = async () => {
        const cs = await api(`/posts/${id}/comments`);
        box.innerHTML = cs.map((c) => `<div class="comment"><a href="#/u/${esc(c.username)}" class="av">${c.avatar}</a><div><b>${esc(c.display_name)}</b> <span class="muted">${ago(c.created_at)}</span><div>${esc(c.content)}</div></div></div>`).join('') + (session() ? '<div class="row"><input placeholder="Write a comment…" maxlength="300"><button class="btn">Reply</button></div>' : '');
        const inp = $('input', box); if (!inp) return;
        const send = async () => { if (!inp.value.trim()) return; await api(`/posts/${id}/comments`, { method: 'POST', body: { content: inp.value } }); $('[data-cm] span', el).textContent = cs.length + 1; draw(); };
        $('button', box).onclick = send; inp.onkeydown = (e) => { if (e.key === 'Enter') send(); };
      };
      draw();
    };
  });
}
async function suggestions() {
  if (!session()) return '';
  const us = (await api('/users')).filter((u) => !u.following).slice(0, 5);
  return `<div class="card side"><h3>Who to follow</h3>${us.map((u) => `<div class="row" style="margin:10px 0"><a class="av" href="#/u/${esc(u.username)}">${u.avatar}</a><div style="flex:1"><b>${esc(u.display_name)}</b><div class="muted">@${esc(u.username)}</div></div><button class="btn ghost" data-f="${esc(u.username)}">Follow</button></div>`).join('') || '<p class="muted">You follow everyone!</p>'}</div>`;
}
function wireFollow(root) {
  root.querySelectorAll('[data-f]').forEach((b) => (b.onclick = async () => {
    const on = b.textContent === 'Follow';
    await api(`/users/${b.dataset.f}/follow`, { method: on ? 'POST' : 'DELETE' });
    b.textContent = on ? 'Following' : 'Follow'; b.className = on ? 'btn' : 'btn ghost';
    if (location.hash === '' || location.hash === '#/') setTimeout(route, 300);
  }));
}
function meCard() {
  const u = session().user;
  return `<div class="card side" style="text-align:center"><div class="av big">${u.avatar}</div><h3>${esc(u.display_name)}</h3><div class="muted">@${esc(u.username)}</div><p>${esc(u.bio) || '<span class="muted">No bio yet</span>'}</p><a class="btn ghost" href="#/u/${esc(u.username)}">View profile</a></div>`;
}
const views = {
  async home() {
    if (!session()) return views.login();
    $('#view').innerHTML = `<div class="layout"><div>${meCard()}</div><div><div class="card" style="margin-bottom:16px"><textarea id="np" rows="3" maxlength="500" placeholder="What's happening, ${esc(session().user.display_name)}?"></textarea><div class="row between" style="margin-top:8px"><span class="muted" id="cnt">0/500</span><button class="btn" id="pb">Post</button></div></div><div id="feed"></div></div><div id="sug"></div></div>`;
    const load = async () => { const ps = await api('/feed'); $('#feed').innerHTML = ps.map(postHtml).join('') || '<div class="card muted">Your feed is empty. Follow people to see their posts here!</div>'; wirePosts($('#feed'), load); };
    $('#np').oninput = () => ($('#cnt').textContent = `${$('#np').value.length}/500`);
    $('#pb').onclick = async () => { if (!$('#np').value.trim()) return; await api('/posts', { method: 'POST', body: { content: $('#np').value } }); $('#np').value = ''; load(); };
    load(); $('#sug').innerHTML = await suggestions(); wireFollow($('#sug'));
  },
  async explore() {
    $('#view').innerHTML = `<div style="max-width:640px;margin:auto"><h1>Explore</h1><p class="muted">Latest posts from everyone on Circle</p><div id="feed"></div></div>`;
    const load = async () => { $('#feed').innerHTML = (await api('/explore')).map(postHtml).join(''); wirePosts($('#feed'), load); };
    load();
  },
  async people() {
    $('#view').innerHTML = `<div style="max-width:640px;margin:auto"><h1>People</h1><input id="q" placeholder="Search people…"><div id="list" style="margin-top:14px"></div></div>`;
    const load = async () => {
      const us = await api('/users?q=' + encodeURIComponent($('#q').value));
      $('#list').innerHTML = us.map((u) => `<div class="card row" style="margin-bottom:10px"><a class="av" href="#/u/${esc(u.username)}">${u.avatar}</a><div style="flex:1"><a href="#/u/${esc(u.username)}"><b>${esc(u.display_name)}</b></a> <span class="muted">@${esc(u.username)}</span><div class="muted">${esc(u.bio)}</div></div>${session() ? `<button class="${u.following ? 'btn' : 'btn ghost'}" data-f="${esc(u.username)}">${u.following ? 'Following' : 'Follow'}</button>` : ''}</div>`).join('');
      wireFollow($('#list'));
    };
    $('#q').oninput = load; load();
  },
  async u(name) {
    const p = await api('/users/' + encodeURIComponent(name));
    const mine = session()?.user.username === p.username;
    $('#view').innerHTML = `<div style="max-width:680px;margin:auto"><div class="card row" style="gap:22px;margin-bottom:16px"><div class="av big">${p.avatar}</div><div style="flex:1"><h1 style="margin:0">${esc(p.display_name)}</h1><div class="muted">@${esc(p.username)} · joined ${esc(p.created_at.slice(0, 10))}</div><p>${esc(p.bio) || '<span class="muted">No bio yet</span>'}</p><div class="stats"><span><b>${p.post_count}</b>Posts</span><span><b id="fc">${p.followers}</b>Followers</span><span><b>${p.following_count}</b>Following</span></div></div>${mine ? '<button class="btn ghost" id="edit">Edit profile</button>' : session() ? `<button class="${p.is_following ? 'btn' : 'btn ghost'}" data-f="${esc(p.username)}">${p.is_following ? 'Following' : 'Follow'}</button>` : ''}</div><div id="ed"></div><div id="feed">${p.posts.map(postHtml).join('') || '<div class="card muted">No posts yet.</div>'}</div></div>`;
    wirePosts($('#feed'), () => views.u(name));
    document.querySelectorAll('[data-f]').forEach((b) => (b.onclick = async () => { const on = b.textContent === 'Follow'; await api(`/users/${p.username}/follow`, { method: on ? 'POST' : 'DELETE' }); views.u(name); }));
    if (mine) $('#edit').onclick = async () => {
      const avs = await api('/avatars'); let av = p.avatar;
      $('#ed').innerHTML = `<div class="card" style="margin-bottom:16px"><h3>Edit profile</h3><label>Avatar</label><div class="avpick">${avs.map((a) => `<span class="${a === av ? 'sel' : ''}">${a}</span>`).join('')}</div><label>Display name</label><input id="dn" maxlength="40" value="${esc(p.display_name)}"><label>Bio</label><textarea id="bio" maxlength="160" rows="2">${esc(p.bio)}</textarea><button class="btn" id="save" style="margin-top:10px">Save</button></div>`;
      $('#ed').querySelectorAll('.avpick span').forEach((s) => (s.onclick = () => { av = s.textContent; $('#ed').querySelectorAll('.avpick span').forEach((x) => x.classList.toggle('sel', x === s)); }));
      $('#save').onclick = async () => { const u = await api('/me', { method: 'PUT', body: { display_name: $('#dn').value, bio: $('#bio').value, avatar: av } }); const s = session(); s.user = u; localStorage.setItem('circle_session', JSON.stringify(s)); header(); views.u(name); };
    };
  },
  login() {
    $('#view').innerHTML = `<div class="card auth"><div style="text-align:center;font-size:48px">🔵</div><h2 id="t" style="text-align:center">Welcome back to Circle</h2><label>Username</label><input id="u"><label>Password</label><input id="p" type="password"><p class="err" id="err"></p><button class="btn" id="go" style="width:100%">Log in</button><p class="muted" style="text-align:center"><span id="swl">New here?</span> <a href="#" id="sw">Create an account</a></p></div>`;
    let mode = 'login';
    $('#sw').onclick = (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; $('#t').textContent = mode === 'login' ? 'Welcome back to Circle' : 'Join Circle'; $('#go').textContent = mode === 'login' ? 'Log in' : 'Sign up'; $('#sw').textContent = mode === 'login' ? 'Create an account' : 'Log in'; $('#swl').textContent = mode === 'login' ? 'New here?' : 'Already have an account?'; };
    const go = async () => { try { const s = await api('/' + mode, { method: 'POST', body: { username: $('#u').value, password: $('#p').value } }); localStorage.setItem('circle_session', JSON.stringify(s)); location.hash = '#/'; route(); } catch (e) { $('#err').textContent = e.message; } };
    $('#go').onclick = go; $('#p').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  },
};
function route() {
  header();
  const [name, arg] = location.hash.slice(2).split('/');
  Promise.resolve().then(() => (views[name] || views.home)(arg && decodeURIComponent(arg))).catch((e) => ($('#view').innerHTML = `<div class="card err">${esc(e.message)}</div>`));
}
window.onhashchange = route; route();
