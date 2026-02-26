import axios from "axios";
import { Prisma, CalendarDay, Listing } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getGuestyAccessToken } from "../lib/guestyToken";

type GuestyAvailabilityDay = {
  date?: string;
  available?: boolean;
  price?: number;
  nightlyPrice?: number;
  basePrice?: number;
  defaultDailyPrice?: number;
  minimumStay?: number;
  minNights?: number;
  minStay?: number;
};

type GuestyAvailabilityResponse = {
  results?: GuestyAvailabilityDay[];
  days?: GuestyAvailabilityDay[];
  data?: GuestyAvailabilityDay[];
};

function getGuestyBaseUrl(): string {
  return (
    process.env.GUESTY_API_BASE_URL ?? "https://api.guesty.com/api/v2"
  );
}

function getGuestyAvailabilityUrl(): string {
  // Allow overriding the exact path via env; otherwise default to a common pattern.
  const baseUrl = getGuestyBaseUrl();
  const path = process.env.GUESTY_AVAILABILITY_PATH ?? "/availability";
  return `${baseUrl}${path}`;
}

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addMonths(d: Date, months: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

async function getListingWithHost(
  listingId: number
): Promise<Listing & { hostId: number }> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
  });

  if (!listing) {
    throw new Error(`Listing ${listingId} not found`);
  }

  if (!listing.guestyId) {
    throw new Error(
      `Listing ${listingId} does not have a linked Guesty ID`
    );
  }

  return listing;
}

export async function syncCalendarForListing(
  listingId: number
): Promise<CalendarDay[]> {
  const listing = await getListingWithHost(listingId);

  const hostId = listing.hostId;
  const guestyListingId = listing.guestyId;

  const accessToken = await getGuestyAccessToken(hostId);

  const start = startOfDayUtc(new Date());
  const end = startOfDayUtc(addMonths(start, 6));

  const url = getGuestyAvailabilityUrl();

  const { data } = await axios.get<GuestyAvailabilityResponse>(url, {
    params: {
      listingId: guestyListingId,
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    },
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const rawDays =
    data.results ?? data.days ?? data.data ?? [];

  const syncedDays: CalendarDay[] = [];

  for (const raw of rawDays) {
    if (!raw.date) {
      continue;
    }

    const dateOnly = startOfDayUtc(new Date(raw.date));

    const available = raw.available ?? true;

    const basePriceNumber =
      raw.price ??
      raw.nightlyPrice ??
      raw.basePrice ??
      raw.defaultDailyPrice ??
      Number(listing.basePrice ?? 0);

    const priceDecimal = new Prisma.Decimal(
      Number.isFinite(basePriceNumber) ? basePriceNumber : 0
    );

    const minStay =
      raw.minimumStay ??
      raw.minNights ??
      raw.minStay ??
      1;

    const day = await prisma.calendarDay.upsert({
      where: {
        listingId_date: {
          listingId: listing.id,
          date: dateOnly,
        },
      },
      create: {
        listing: {
          connect: { id: listing.id },
        },
        date: dateOnly,
        available,
        price: priceDecimal,
        minStay,
      },
      update: {
        available,
        price: priceDecimal,
        minStay,
      },
    });

    syncedDays.push(day);
  }

  return syncedDays;
}

