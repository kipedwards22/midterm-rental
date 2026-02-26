import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { syncQueue } from "../jobs/syncQueue";

const router = Router();

const JWT_EXPIRY = "7d";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable must be set");
  }
  return secret;
}

function signHostJwt(hostId: string): string {
  const secret = getJwtSecret();
  const payload = { sub: hostId, hostId };
  return jwt.sign(payload, secret, { expiresIn: JWT_EXPIRY });
}

router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body ?? {};

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const existing = await prisma.host.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const host = await prisma.host.create({
      data: {
        email,
        name: name ?? null,
        passwordHash,
      },
    });

    const token = signHostJwt(host.id);

    return res.status(201).json({
      token,
      host: {
        id: host.id,
        email: host.email,
        name: host.name,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in /auth/register", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body ?? {};

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const host = await prisma.host.findUnique({
      where: { email },
    });

    if (!host || !host.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, host.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signHostJwt(host.id);

    return res.json({
      token,
      host: {
        id: host.id,
        email: host.email,
        name: host.name,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in /auth/login", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

function getGuestyAuthUrl(): string {
  return process.env.GUESTY_AUTH_URL ?? "https://auth.guesty.com/oauth2/authorize";
}

function getGuestyTokenUrl(): string {
  return process.env.GUESTY_TOKEN_URL ?? "https://id.guesty.com/oauth/token";
}

router.get("/guesty", async (req, res) => {
  try {
    const clientId = process.env.GUESTY_CLIENT_ID?.trim();
    const redirectUri = process.env.GUESTY_REDIRECT_URI;
    const scope =
      process.env.GUESTY_SCOPE ??
      "offline_access listings.read reservations.read";

    if (!clientId || !redirectUri) {
      return res
        .status(500)
        .json({ error: "Guesty OAuth is not configured on the server" });
    }

    const hostId =
      (req.query.hostId as string | undefined) ??
      (req.query.host_id as string | undefined);

    if (!hostId) {
      return res
        .status(400)
        .json({ error: "hostId query parameter is required" });
    }

    const host = await prisma.host.findUnique({
      where: { id: hostId },
      select: { id: true },
    });

    if (!host) {
      return res.status(404).json({ error: "Host not found" });
    }

    const authBase = getGuestyAuthUrl();
    const url = new URL(authBase);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", hostId);

    return res.redirect(url.toString());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in /auth/guesty", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

type GuestyOAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  account_id?: string;
  accountId?: string;
};

router.get("/guesty/callback", async (req, res) => {
  try {
    const { code, state } = req.query as {
      code?: string;
      state?: string;
    };

    if (!code || !state) {
      return res
        .status(400)
        .json({ error: "Missing `code` or `state` query parameter" });
    }

    const clientId = process.env.GUESTY_CLIENT_ID?.trim();
    const clientSecret = process.env.GUESTY_CLIENT_SECRET;
    const redirectUri = process.env.GUESTY_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return res
        .status(500)
        .json({ error: "Guesty OAuth is not configured on the server" });
    }

    const hostId = state;

    const tokenUrl = getGuestyTokenUrl();

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      // eslint-disable-next-line no-console
      console.error("Guesty token exchange failed", {
        status: tokenResponse.status,
        body: text,
      });
      return res
        .status(502)
        .json({ error: "Failed to exchange Guesty authorization code" });
    }

    const tokenJson = (await tokenResponse.json()) as GuestyOAuthTokenResponse;

    if (!tokenJson.access_token) {
      return res
        .status(502)
        .json({ error: "Guesty token response missing access_token" });
    }

    const guestyAccountId =
      tokenJson.account_id ?? tokenJson.accountId ?? null;

    const expiresAt =
      typeof tokenJson.expires_in === "number"
        ? new Date(Date.now() + tokenJson.expires_in * 1000)
        : null;

    const host = await prisma.host.update({
      where: { id: hostId },
      data: {
        guestyAccountId,
        guestyAccessToken: tokenJson.access_token,
        guestyRefreshToken:
          tokenJson.refresh_token ?? null,
        guestyTokenType: tokenJson.token_type ?? null,
        guestyScope: tokenJson.scope ?? null,
        guestyExpiresAt: expiresAt,
      },
    });

    // Queue initial listing sync for this host
    void syncQueue.add("sync-listings", { hostId: host.id });

    const jwtToken = signHostJwt(host.id);

    return res.json({
      token: jwtToken,
      host: {
        id: host.id,
        email: host.email,
        name: host.name,
        guestyAccountId: host.guestyAccountId,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in /auth/guesty/callback", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

