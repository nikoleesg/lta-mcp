const BUS_ARRIVAL_URL = "https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival";

/**
 * Raw DataMall shapes, exactly as the API returns them. Note that every
 * scalar except `Monitored` is a *string*, including latitude/longitude and
 * VisitNumber — and that when there is no further bus, the whole NextBus2 /
 * NextBus3 object is still present with every field blank rather than absent.
 */
interface RawNextBus {
  OriginCode: string;
  DestinationCode: string;
  EstimatedArrival: string;
  Monitored: number;
  Latitude: string;
  Longitude: string;
  VisitNumber: string;
  Load: string;
  Feature: string;
  Type: string;
}

interface RawService {
  ServiceNo: string;
  Operator: string;
  NextBus: RawNextBus;
  NextBus2: RawNextBus;
  NextBus3: RawNextBus;
}

interface RawBusArrivalResponse {
  BusStopCode?: string;
  Services?: RawService[];
}

/** Public Transport Operator codes (API User Guide §2.1). */
const OPERATORS: Record<string, string> = {
  SBST: "SBS Transit",
  SMRT: "SMRT Corporation",
  TTS: "Tower Transit Singapore",
  GAS: "Go-Ahead Singapore"
};

/** Bus occupancy / crowding levels (API User Guide §2.1). */
const LOADS: Record<string, string> = {
  SEA: "Seats available",
  SDA: "Standing available",
  LSD: "Limited standing"
};

/** Vehicle types (API User Guide §2.1). */
const VEHICLE_TYPES: Record<string, string> = {
  SD: "Single deck",
  DD: "Double deck",
  BD: "Bendy"
};

/**
 * Decodes a DataMall code to its documented meaning, falling back to the raw
 * code if LTA adds a value we don't know yet — better to pass through an
 * unrecognised "XX" than to drop the field or claim it means nothing.
 */
function decode(table: Record<string, string>, code: string): string {
  return table[code] ?? code;
}

export interface Arrival {
  /** ETA as returned by DataMall: ISO 8601 with the +08:00 Singapore offset. */
  estimatedArrival: string;
  /**
   * Whole minutes from now until `estimatedArrival`, rounded *down* per the
   * guide's display rule (3:49 -> 3). Clamped at 0, which the guide renders
   * as "Arr": arriving now, or a moment overdue.
   */
  minutesAway: number;
  /**
   * true  — ETA estimated from the bus's live location.
   * false — ETA is the operator's schedule (`Monitored: 0`), so it may shift.
   */
  monitored: boolean;
  /** Crowding level, decoded: "Seats available" | "Standing available" | "Limited standing". */
  load: string;
  /** Vehicle type, decoded: "Single deck" | "Double deck" | "Bendy". */
  type: string;
  /** Whether this bus is wheelchair accessible (DataMall's `Feature: "WAB"`). */
  wheelchairAccessible: boolean;
  /** Bus stop code where this bus began its service. */
  originCode: string;
  /** Bus stop code where this bus terminates. */
  destinationCode: string;
  /** nth visit of this vehicle to this stop (1 = first visit). */
  visitNumber: number;
  /** Current position of the bus — present only when `monitored` is true. */
  latitude?: number;
  longitude?: number;
}

export interface ServiceArrivals {
  serviceNo: string;
  /** Operator, decoded: e.g. "Go-Ahead Singapore". */
  operator: string;
  /** Up to 3 oncoming buses, soonest first. Blank NextBus2/NextBus3 slots are dropped. */
  arrivals: Arrival[];
}

export interface BusArrivalResult {
  busStopCode: string;
  /** When this snapshot was taken, ISO 8601 in SST — the baseline `minutesAway` counts from. */
  retrievedAt: string;
  services: ServiceArrivals[];
}

/**
 * Formats an instant as ISO 8601 in Singapore Standard Time. SST is a fixed
 * UTC+8 with no DST, so shifting the instant and reading the UTC fields is
 * exact — and avoids depending on the Worker's timezone database.
 */
function toSgtIso(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

/** "HH:mm" in SST, for display. Returns the input unchanged if it isn't a parseable date. */
export function sgtClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return toSgtIso(date).slice(11, 16);
}

/**
 * A blank slot rather than a bus. DataMall keeps the NextBus2/NextBus3 keys
 * present but empties every field when there are fewer than 3 buses left
 * (e.g. late at night), so presence of the object proves nothing.
 */
function isEmptySlot(bus: RawNextBus | undefined): boolean {
  return !bus || !bus.EstimatedArrival;
}

function toArrival(bus: RawNextBus, now: Date): Arrival {
  const eta = new Date(bus.EstimatedArrival);
  const monitored = bus.Monitored === 1;
  const latitude = Number(bus.Latitude);
  const longitude = Number(bus.Longitude);

  const arrival: Arrival = {
    estimatedArrival: bus.EstimatedArrival,
    minutesAway: Math.max(0, Math.floor((eta.getTime() - now.getTime()) / 60_000)),
    monitored,
    load: decode(LOADS, bus.Load),
    type: decode(VEHICLE_TYPES, bus.Type),
    wheelchairAccessible: bus.Feature === "WAB",
    originCode: bus.OriginCode,
    destinationCode: bus.DestinationCode,
    visitNumber: Number(bus.VisitNumber) || 1
  };

  // Unmonitored buses report "0.0" (or blank) coordinates — a placeholder, not
  // a position off the coast of Africa. Only surface a real fix.
  if (monitored && Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude !== 0 || longitude !== 0)) {
    arrival.latitude = latitude;
    arrival.longitude = longitude;
  }

  return arrival;
}

export interface BusArrivalParams {
  busStopCode: string;
  serviceNo?: string;
}

/**
 * Calls DataMall's v3 Bus Arrival endpoint and normalises the response.
 *
 * Throws on a non-2xx status; an empty `services` array is a normal result,
 * not an error — it's what the API returns when no bus is in service at the
 * stop (see the guide's advisement note).
 */
export async function busArrivalLta(params: BusArrivalParams, accountKey: string): Promise<BusArrivalResult> {
  const url = new URL(BUS_ARRIVAL_URL);
  url.searchParams.set("BusStopCode", params.busStopCode);
  if (params.serviceNo) url.searchParams.set("ServiceNo", params.serviceNo);

  const response = await fetch(url, {
    headers: {
      AccountKey: accountKey,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`DataMall returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }

  // Documented behaviour: when the API is under maintenance it may return no
  // body at all rather than an empty Services array, so don't assume JSON.
  const text = await response.text();
  let data: RawBusArrivalResponse;
  try {
    data = text ? (JSON.parse(text) as RawBusArrivalResponse) : {};
  } catch {
    throw new Error(`DataMall returned a non-JSON body: ${text.slice(0, 300)}`);
  }

  const now = new Date();
  const services: ServiceArrivals[] = (data.Services ?? []).map((service) => ({
    serviceNo: service.ServiceNo,
    operator: decode(OPERATORS, service.Operator),
    arrivals: [service.NextBus, service.NextBus2, service.NextBus3]
      .filter((bus): bus is RawNextBus => !isEmptySlot(bus))
      .map((bus) => toArrival(bus, now))
  }));

  // Numeric-aware sort so 15 precedes 150, and 225G/225W stay adjacent.
  services.sort((a, b) => a.serviceNo.localeCompare(b.serviceNo, "en", { numeric: true }));

  return {
    busStopCode: data.BusStopCode || params.busStopCode,
    retrievedAt: toSgtIso(now),
    services
  };
}
