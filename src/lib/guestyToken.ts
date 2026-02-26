import axios from "axios";
import { prisma } from "./prisma";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

type GuestyTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
};

export async function getGuestyAccessToken(hostId: number): Promise<string> {
  const host = await prisma.host.findUnique({
    where: { id: hostId },
  });

  if (!host) {
    throw new Error(`Host ${hostId} not found`);
  }

  const now = Date.now();

  if (
    host.guestyAccessToken &&
    host.guestyExpiresAt &&
    host.guestyExpiresAt.getTime() - now > TOKEN_EXPIRY_BUFFER_MS
  ) {
    return host.guestyAccessToken;
  }

  if (!host.guestyRefreshToken) {
    throw new Error(
      `Host ${hostId} does not have a stored Guesty refresh token`
    );
  }

  const clientId = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "GUESTY_CLIENT_ID and GUESTY_CLIENT_SECRET must be set in the environment"
    );
  }

  const tokenUrl =
    process.env.GUESTY_TOKEN_URL ?? "https://id.guesty.com/oauth/token";

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: host.guestyRefreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const { data } = await axios.post<GuestyTokenResponse>(tokenUrl, params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!data.access_token) {
    throw new Error("Guesty refresh response did not include an access_token");
  }

  const expiresAt =
    typeof data.expires_in === "number"
      ? new Date(Date.now() + data.expires_in * 1000)
      : null;

  const updatedHost = await prisma.host.update({
    where: { id: hostId },
    data: {
      guestyAccessToken: data.access_token,
      guestyRefreshToken: data.refresh_token ?? host.guestyRefreshToken,
      guestyTokenType: data.token_type ?? host.guestyTokenType,
      guestyScope: data.scope ?? host.guestyScope,
      guestyExpiresAt: expiresAt ?? host.guestyExpiresAt,
    },
  });

  if (!updatedHost.guestyAccessToken) {
    throw new Error("Failed to persist Guesty access token to the database");
  }

  return updatedHost.guestyAccessToken;
}

