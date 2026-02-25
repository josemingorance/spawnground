// ═══════════════════════════════════════════════════════════════
// GitHub OAuth — Device Flow (CLI) + Web Flow (Dashboard)
// ═══════════════════════════════════════════════════════════════

const express = require('express');

const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function isEnabled() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

function createAuthRouter(world, { registerOrFindPlayer }) {
  const router = express.Router();

  // ── Device Flow: Step 1 — Start ────────────────────────────
  // CLI/agent calls this, gets a user_code to enter at github.com/login/device
  router.post('/device/start', async (req, res) => {
    if (!isEnabled()) {
      return res.status(501).json({ error: 'OAuth not configured (missing GITHUB_CLIENT_ID)' });
    }

    try {
      const response = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          scope: 'read:user',
        }),
      });
      const data = await response.json();

      if (data.error) {
        return res.status(400).json({ error: data.error, description: data.error_description });
      }

      res.json({
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        device_code: data.device_code,
        expires_in: data.expires_in,
        interval: data.interval,
        message: `Go to ${data.verification_uri} and enter code: ${data.user_code}`,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to contact GitHub', details: err.message });
    }
  });

  // ── Device Flow: Step 2 — Poll ─────────────────────────────
  // CLI/agent polls this until the user authorizes
  router.post('/device/poll', async (req, res) => {
    if (!isEnabled()) {
      return res.status(501).json({ error: 'OAuth not configured' });
    }

    const { device_code } = req.body;
    if (!device_code) {
      return res.status(400).json({ error: 'Missing device_code' });
    }

    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const data = await response.json();

      // Still waiting for user to authorize
      if (data.error) {
        return res.json({ pending: true, error: data.error });
      }

      // Got access token — resolve GitHub identity
      const player = await githubTokenToPlayer(world, data.access_token, registerOrFindPlayer);
      res.json({
        token: player.token,
        player_id: player.id,
        name: player.name,
        github_login: player.githubLogin,
        message: `Authenticated as @${player.githubLogin}. Use this token for all API calls.`,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to contact GitHub', details: err.message });
    }
  });

  // ── Web Flow: Step 1 — Redirect to GitHub ──────────────────
  router.get('/github', (req, res) => {
    if (!isEnabled()) {
      return res.status(501).json({ error: 'OAuth not configured' });
    }

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: `${BASE_URL}/auth/github/callback`,
      scope: 'read:user',
      state: Math.random().toString(36).slice(2),
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // ── Web Flow: Step 2 — GitHub callback ─────────────────────
  router.get('/github/callback', async (req, res) => {
    if (!isEnabled()) {
      return res.status(501).json({ error: 'OAuth not configured' });
    }

    const { code } = req.query;
    if (!code) {
      return res.status(400).send('Missing code parameter');
    }

    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
        }),
      });
      const data = await response.json();

      if (data.error) {
        return res.status(400).send(`GitHub error: ${data.error_description || data.error}`);
      }

      const player = await githubTokenToPlayer(world, data.access_token, registerOrFindPlayer);

      // Redirect to dashboard with token in URL fragment (stays client-side)
      res.redirect(`/?token=${player.token}`);
    } catch (err) {
      res.status(500).send('Authentication failed');
    }
  });

  // ── Info endpoint ──────────────────────────────────────────
  router.get('/info', (req, res) => {
    res.json({
      enabled: isEnabled(),
      client_id: CLIENT_ID || null,
      device_flow: isEnabled(),
      web_flow: isEnabled(),
      login_url: isEnabled() ? `${BASE_URL}/auth/github` : null,
    });
  });

  return router;
}

// ── Shared: verify GitHub token → create/find player ─────────
async function githubTokenToPlayer(world, githubAccessToken, registerOrFindPlayer) {
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${githubAccessToken}`,
      'User-Agent': 'spawnground',
    },
  });

  if (!userRes.ok) {
    throw new Error(`GitHub API returned ${userRes.status}`);
  }

  const ghUser = await userRes.json();

  return registerOrFindPlayer(world, {
    githubId: String(ghUser.id),
    githubLogin: ghUser.login,
    avatarUrl: ghUser.avatar_url,
  });
}

module.exports = { createAuthRouter, isEnabled };
