import { Router } from "express";
import { prisma } from "../lib/prisma";
import { syncQueue } from "../jobs/syncQueue";

const router = Router();

type GuestyWebhookBody = Record<string, any>;

const LISTING_EVENTS = new Set([
  "listing.created",
  "listing.updated",
]);

const RESERVATION_EVENTS = new Set([
  "reservation.created",
  "reservation.updated",
  "reservation.cancelled",
]);

async function resolveHostIdFromPayload(
  body: GuestyWebhookBody
): Promise<number | null> {
  const accountId: string | undefined =
    body.accountId ??
    body.account_id ??
    body.integrationId ??
    body.integration_id ??
    body.account ??
    body.accountID;

  if (!accountId) {
    return null;
  }

  const host = await prisma.host.findUnique({
    where: { guestyAccountId: accountId },
    select: { id: true },
  });

  return host?.id ?? null;
}

function extractGuestyListingId(body: GuestyWebhookBody): string | null {
  const fromListing =
    body.listing?._id ??
    body.listing?.id ??
    body.listingId ??
    body.listing_id;

  const fromReservation =
    body.reservation?.listing?._id ??
    body.reservation?.listing?.id ??
    body.reservation?.listingId ??
    body.reservation?.listing_id;

  const topLevel =
    body._id ??
    body.id;

  return (
    fromListing ??
    fromReservation ??
    topLevel ??
    null
  );
}

router.post("/guesty", async (req, res) => {
  const raw = (req as any).body;
  let body: GuestyWebhookBody;

  if (Buffer.isBuffer(raw)) {
    try {
      body = JSON.parse(raw.toString("utf8")) as GuestyWebhookBody;
    } catch {
      body = {};
    }
  } else if (typeof raw === "string") {
    try {
      body = JSON.parse(raw) as GuestyWebhookBody;
    } catch {
      body = {};
    }
  } else {
    body = (raw as GuestyWebhookBody) ?? {};
  }

  const eventType: string =
    (body.event ?? body.type ?? "").toString();

  try {
    if (LISTING_EVENTS.has(eventType)) {
      const [hostId, guestyListingId] = await Promise.all([
        resolveHostIdFromPayload(body),
        Promise.resolve(extractGuestyListingId(body)),
      ]);

      if (hostId != null && guestyListingId) {
        void syncQueue.add("sync-single-listing", {
          hostId,
          guestyListingId,
        });
      }
    } else if (RESERVATION_EVENTS.has(eventType)) {
      const guestyListingId = extractGuestyListingId(body);

      if (guestyListingId) {
        const listing = await prisma.listing.findUnique({
          where: { guestyId: guestyListingId },
          select: { id: true },
        });

        if (listing) {
          void syncQueue.add("sync-calendar", {
            listingId: listing.id,
          });
        }
      }
    }
  } catch (err) {
    // Log and swallow errors so webhooks still respond 200 as requested.
    // eslint-disable-next-line no-console
    console.error("Error handling Guesty webhook", {
      error: err,
      eventType,
    });
  }

  res.status(200).json({ ok: true });
});

export default router;

