import axios from "axios";
import { Prisma, Listing } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getGuestyAccessToken } from "../lib/guestyToken";

const DEFAULT_PAGE_SIZE = 50;

type GuestyAddress = {
  full?: string;
  street?: string;
  line1?: string;
  line2?: string;
  address1?: string;
  address2?: string;
  apt?: string;
  city?: string;
  state?: string;
  province?: string;
  zip?: string;
  postalCode?: string;
  country?: string;
};

type GuestyLocation = {
  lat?: number;
  lng?: number;
  latitude?: number;
  longitude?: number;
};

type GuestyListing = {
  _id?: string;
  id?: string;
  title?: string;
  name?: string;
  description?: string;
  propertyType?: string;
  propertyTypeCategory?: string;
  bedrooms?: number;
  bathrooms?: number;
  beds?: number;
  accommodates?: number;
  maxGuests?: number;
  address?: GuestyAddress;
  location?: GuestyLocation;
  geo?: GuestyLocation;
  amenities?: string[];
  pictures?: unknown;
  images?: unknown;
  basePrice?: number;
  defaultDailyPrice?: number;
  dailyRate?: number;
};

type GuestyListResponse = {
  results?: GuestyListing[];
  data?: GuestyListing[];
  page?: number;
  pages?: number;
  limit?: number;
};

function getGuestyBaseUrl(): string {
  return (
    process.env.GUESTY_API_BASE_URL ?? "https://api.guesty.com/api/v2"
  );
}

function extractGuestyId(listing: GuestyListing): string | null {
  return listing._id ?? listing.id ?? null;
}

function mapGuestyListingToPrismaData(guesty: GuestyListing, hostId: number) {
  const address = guesty.address ?? {};
  const loc = guesty.location ?? guesty.geo ?? {};

  const title =
    guesty.title ?? guesty.name ?? address.full ?? "Untitled listing";

  const photos = guesty.pictures ?? guesty.images ?? [];
  const amenities = guesty.amenities ?? [];

  const basePriceNumber =
    guesty.basePrice ??
    guesty.defaultDailyPrice ??
    guesty.dailyRate ??
    0;

  const basePriceDecimal = new Prisma.Decimal(basePriceNumber);

  const create = {
    guestyId: extractGuestyId(guesty) ?? "",
    host: {
      connect: { id: hostId },
    },
    title,
    description: guesty.description ?? null,
    propertyType:
      guesty.propertyType ?? guesty.propertyTypeCategory ?? null,
    bedrooms: guesty.bedrooms ?? null,
    bathrooms: guesty.bathrooms ?? null,
    beds: guesty.beds ?? null,
    maxGuests: guesty.maxGuests ?? guesty.accommodates ?? null,
    addressLine1:
      address.street ??
      address.line1 ??
      address.address1 ??
      null,
    addressLine2:
      address.apt ??
      address.line2 ??
      address.address2 ??
      null,
    city: address.city ?? null,
    state: address.state ?? address.province ?? null,
    postalCode: address.zip ?? address.postalCode ?? null,
    country: address.country ?? null,
    latitude:
      typeof loc.lat === "number"
        ? loc.lat
        : typeof loc.latitude === "number"
        ? loc.latitude
        : null,
    longitude:
      typeof loc.lng === "number"
        ? loc.lng
        : typeof loc.longitude === "number"
        ? loc.longitude
        : null,
    photos,
    amenities,
    basePrice: basePriceDecimal,
    calendarDays: {
      create: [],
    },
  };

  const update = {
    title,
    description: guesty.description ?? null,
    propertyType:
      guesty.propertyType ?? guesty.propertyTypeCategory ?? null,
    bedrooms: guesty.bedrooms ?? null,
    bathrooms: guesty.bathrooms ?? null,
    beds: guesty.beds ?? null,
    maxGuests: guesty.maxGuests ?? guesty.accommodates ?? null,
    addressLine1:
      address.street ??
      address.line1 ??
      address.address1 ??
      null,
    addressLine2:
      address.apt ??
      address.line2 ??
      address.address2 ??
      null,
    city: address.city ?? null,
    state: address.state ?? address.province ?? null,
    postalCode: address.zip ?? address.postalCode ?? null,
    country: address.country ?? null,
    latitude:
      typeof loc.lat === "number"
        ? loc.lat
        : typeof loc.latitude === "number"
        ? loc.latitude
        : null,
    longitude:
      typeof loc.lng === "number"
        ? loc.lng
        : typeof loc.longitude === "number"
        ? loc.longitude
        : null,
    photos,
    amenities,
    basePrice: basePriceDecimal,
  };

  return { create, update };
}

export async function syncAllListingsForHost(
  hostId: number
): Promise<Listing[]> {
  const accessToken = await getGuestyAccessToken(hostId);
  const baseUrl = getGuestyBaseUrl();

  let page = 1;
  const limit = DEFAULT_PAGE_SIZE;
  const syncedListings: Listing[] = [];

  // Simple page-based pagination; this can be adapted if you use cursor-based pagination instead.
  // Continue until we reach the reported number of pages, or we get fewer than `limit` results.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await axios.get<GuestyListResponse>(
      `${baseUrl}/listings`,
      {
        params: { page, limit },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const rawListings = data.results ?? data.data ?? [];

    if (rawListings.length === 0) {
      break;
    }

    for (const raw of rawListings) {
      const guestyId = extractGuestyId(raw);
      if (!guestyId) {
        continue;
      }

      const { create, update } = mapGuestyListingToPrismaData(raw, hostId);

      const listing = await prisma.listing.upsert({
        where: { guestyId },
        create,
        update,
      });

      syncedListings.push(listing);
    }

    if (data.pages && page >= data.pages) {
      break;
    }

    if (!data.pages && rawListings.length < limit) {
      break;
    }

    page += 1;
  }

  return syncedListings;
}

export async function syncListingByGuestyId(
  hostId: number,
  guestyListingId: string
): Promise<Listing> {
  const accessToken = await getGuestyAccessToken(hostId);
  const baseUrl = getGuestyBaseUrl();

  const { data } = await axios.get<GuestyListing>(
    `${baseUrl}/listings/${encodeURIComponent(guestyListingId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const guestyId = extractGuestyId(data) ?? guestyListingId;

  const { create, update } = mapGuestyListingToPrismaData(data, hostId);
  create.guestyId = guestyId;

  const listing = await prisma.listing.upsert({
    where: { guestyId },
    create,
    update,
  });

  return listing;
}

