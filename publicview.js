// publicview.js
// The read-only PUBLIC surface: what a logged-out visitor, Google, or a social-media
// link scraper is allowed to see WITHOUT an account. This is the single security
// boundary for public exposure, so it is deliberately strict and lives in one place.
//
// Only GENUINELY world-visible content is ever returned:
//   - a post is public iff visibility='visible' AND it is not a group post AND
//     (it is a public personal post OR it lives in a PUBLIC community);
//   - a profile is public iff its profile_visibility is 'public';
//   - friends-only posts, private/friends-only communities, group posts, removed or
//     auto-hidden content, and non-public profiles are NEVER exposed here.
// Blocks/mutes do not apply (there is no logged-in viewer). Nothing here needs auth.

const db = require('./db');
const { publicUser } = require('./auth');
const { decoratePost, decoratePosts } = require('./postview');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Absolute URL for an OG image (scrapers need an absolute URL). Media that already
// lives on the CDN is absolute; a local /uploads/ path is prefixed with the base URL.
function absUrl(base, u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return base.replace(/\/$/, '') + (u.charAt(0) === '/' ? u : '/' + u);
}

// Is this raw post row world-visible? The shared predicate used everywhere below.
async function isPublicPostRow(p) {
  if (!p) return false;
  if ((p.visibility || 'visible') !== 'visible') return false;
  if (p.group_id) return false;
  if (p.community_id) {
    const c = await db.prepare('SELECT privacy FROM communities WHERE id = ?').get(p.community_id);
    return !!(c && c.privacy === 'public');
  }
  return p.audience === 'public';
}

// A single public post (decorated for a viewer-less render), or null.
async function publicPost(id) {
  const p = await db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(id));
  if (!(await isPublicPostRow(p))) return null;
  const post = await decoratePost(p, 0);
  post.comments = await publicComments(p.id);
  return post;
}

// Visible top-level + threaded comments on a public post. Removed/hidden comments are
// dropped (no viewer, so nothing is tombstoned, just omitted).
async function publicComments(postId) {
  const rows = await db
    .prepare("SELECT * FROM comments WHERE post_id = ? AND visibility = 'visible' ORDER BY created_at ASC, id ASC LIMIT 200")
    .all(Number(postId));
  if (!rows.length) return [];
  // Batch the author lookup into ONE query (avoid an N+1: a hot post could otherwise
  // fire up to 200 networked reads on a single unauthenticated page view).
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const ph = ids.map(() => '?').join(',');
  const byId = new Map();
  for (const u of await db.prepare('SELECT * FROM users WHERE id IN (' + ph + ')').all(...ids)) byId.set(u.id, publicUser(u));
  return rows.map((c) => ({
    id: c.id,
    parent_id: c.parent_id || null,
    content: c.content,
    created_at: c.created_at,
    author: byId.get(c.user_id) || null,
  }));
}

// A public profile (only if profile_visibility = 'public') plus its public posts, or null.
async function publicProfile(handle) {
  const raw = String(handle || '').replace(/^@/, '');
  const user = /^\d+$/.test(raw)
    ? await db.prepare('SELECT * FROM users WHERE id = ?').get(Number(raw))
    : await db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(raw);
  if (!user) return null;
  if ((user.profile_visibility || 'public') !== 'public') return null;
  const rows = await db.prepare(
    "SELECT p.* FROM posts p LEFT JOIN communities c ON c.id = p.community_id " +
    "WHERE p.user_id = ? AND p.visibility = 'visible' AND p.group_id IS NULL AND p.announcement = 0 " +
    "AND ((p.community_id IS NULL AND p.audience = 'public') OR (p.community_id IS NOT NULL AND c.privacy = 'public')) " +
    "ORDER BY p.created_at DESC LIMIT 20"
  ).all(user.id);
  const followers = (await db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id = ?').get(user.id)).c;
  return { user: publicUser(user), posts: await decoratePosts(rows, 0), followersCount: followers, postsCount: rows.length };
}

// The public Discover feed: newest public content site-wide (personal public posts +
// posts in public communities), for a logged-out taste of the network and for SEO.
async function publicDiscover(limit) {
  const n = Math.min(Number(limit) || 30, 50);
  const rows = await db.prepare(
    "SELECT p.* FROM posts p LEFT JOIN communities c ON c.id = p.community_id " +
    "WHERE p.visibility = 'visible' AND p.group_id IS NULL AND p.announcement = 0 " +
    "AND ((p.community_id IS NULL AND p.audience = 'public') OR (p.community_id IS NOT NULL AND c.privacy = 'public')) " +
    "ORDER BY p.created_at DESC, p.id DESC LIMIT ?"
  ).all(n);
  return decoratePosts(rows, 0);
}

// Public communities (for a logged-out browse + the sitemap).
async function publicCommunities(limit) {
  const n = Math.min(Number(limit) || 30, 100);
  const rows = await db.prepare(
    "SELECT id, name, description FROM communities WHERE privacy = 'public' ORDER BY created_at DESC LIMIT ?"
  ).all(n);
  return rows;
}

// Ids/handles for the sitemap: recent public posts + public-profile usernames + public communities.
async function sitemapEntries() {
  const posts = await db.prepare(
    "SELECT p.id FROM posts p LEFT JOIN communities c ON c.id = p.community_id " +
    "WHERE p.visibility = 'visible' AND p.group_id IS NULL " +
    "AND ((p.community_id IS NULL AND p.audience = 'public') OR (p.community_id IS NOT NULL AND c.privacy = 'public')) " +
    "ORDER BY p.created_at DESC LIMIT 1000"
  ).all();
  const users = await db.prepare(
    "SELECT username FROM users WHERE (profile_visibility IS NULL OR profile_visibility = 'public') AND username IS NOT NULL AND username != '' LIMIT 1000"
  ).all();
  return { postIds: posts.map((r) => r.id), usernames: users.map((r) => r.username) };
}

// Build the Open Graph / Twitter-card meta tags a scraper reads. Escaped + length-capped.
function ogMeta({ title, description, url, image, type }) {
  const t = esc(title).slice(0, 140);
  const d = esc(String(description || '').replace(/\s+/g, ' ').trim()).slice(0, 200);
  const tags = [
    '<meta property="og:site_name" content="OpenBook">',
    '<meta property="og:type" content="' + esc(type || 'website') + '">',
    '<meta property="og:title" content="' + t + '">',
    '<meta property="og:description" content="' + d + '">',
    '<meta property="og:url" content="' + esc(url) + '">',
    '<meta name="twitter:card" content="' + (image ? 'summary_large_image' : 'summary') + '">',
    '<meta name="twitter:title" content="' + t + '">',
    '<meta name="twitter:description" content="' + d + '">',
    '<meta name="description" content="' + d + '">',
  ];
  if (image) {
    tags.push('<meta property="og:image" content="' + esc(image) + '">');
    tags.push('<meta name="twitter:image" content="' + esc(image) + '">');
  }
  return tags.join('\n    ');
}

module.exports = {
  esc, absUrl, isPublicPostRow, publicPost, publicComments, publicProfile,
  publicDiscover, publicCommunities, sitemapEntries, ogMeta,
};
