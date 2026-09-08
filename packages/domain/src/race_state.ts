import type { RaceEvent, RawRecord } from "./types.js";

// `structuredClone` is a runtime global in both Node and every current
// browser; the `types: []` / `lib: ["ES2022"]` restriction on this
// package (ADR-0002) just means no lib.dom.d.ts or @types/node ships its
// declaration here, so it is declared locally instead of widening `lib`.
declare function structuredClone<T>(value: T): T;

export interface DriverState {
  driver_number: number;
  full_name: string | null;
  name_acronym: string | null;
  team_name: string | null;
  team_colour: string | null;
  position: number | null;
  interval: number | null;
  gap_to_leader: number | null;
  current_lap: number | null;
  lap_duration: number | null;
  sector_durations: {
    sector_1: number | null;
    sector_2: number | null;
    sector_3: number | null;
  };
  is_pit_out_lap: boolean | null;
  tyre: {
    stint_number: number | null;
    compound: string | null;
    lap_start: number | null;
    lap_end: number | null;
    age_at_start: number | null;
    age: number | null;
  };
  pit_stops: RawRecord[];
  latest_pit_stop: RawRecord | null;
  source_timestamps: Record<string, string>;
}

export interface RaceState {
  sequence: number;
  latest_source_time: string | null;
  session: RawRecord | null;
  drivers: Record<string, DriverState>;
  driver_order: number[];
  race_control: {
    session_status: string | null;
    current_flag: string | null;
    safety_car: "SC" | "VSC" | null;
    active_flags: Record<string, string>;
    driver_flags: Record<string, string>;
    recent_messages: Array<{ event_id: string; payload: RawRecord }>;
  };
  weather: RawRecord | null;
  anomalies: {
    duplicate_events: number;
    stale_updates: number;
    missing_driver: number;
    unsupported_events: number;
  };
}

function numberValue(record: RawRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function stringValue(record: RawRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function booleanValue(record: RawRecord, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function sourceMillis(sourceTime: string | null): number | null {
  return sourceTime === null ? null : Date.parse(sourceTime);
}

function newDriver(driverNumber: number, metadata: RawRecord = {}): DriverState {
  return {
    driver_number: driverNumber,
    full_name: stringValue(metadata, "full_name"),
    name_acronym: stringValue(metadata, "name_acronym"),
    team_name: stringValue(metadata, "team_name"),
    team_colour: stringValue(metadata, "team_colour"),
    position: null,
    interval: null,
    gap_to_leader: null,
    current_lap: null,
    lap_duration: null,
    sector_durations: {
      sector_1: null,
      sector_2: null,
      sector_3: null,
    },
    is_pit_out_lap: null,
    tyre: {
      stint_number: null,
      compound: null,
      lap_start: null,
      lap_end: null,
      age_at_start: null,
      age: null,
    },
    pit_stops: [],
    latest_pit_stop: null,
    source_timestamps: {},
  };
}

export function createInitialState(metadata: {
  sessions: RawRecord[];
  drivers: RawRecord[];
}): RaceState {
  const drivers: Record<string, DriverState> = {};
  for (const driver of metadata.drivers) {
    const driverNumber = numberValue(driver, "driver_number");
    if (driverNumber !== null) {
      drivers[String(driverNumber)] = newDriver(driverNumber, driver);
    }
  }

  return {
    sequence: 0,
    latest_source_time: null,
    session: metadata.sessions[0] ?? null,
    drivers,
    driver_order: [],
    race_control: {
      session_status: null,
      current_flag: null,
      safety_car: null,
      active_flags: {},
      driver_flags: {},
      recent_messages: [],
    },
    weather: null,
    anomalies: {
      duplicate_events: 0,
      stale_updates: 0,
      missing_driver: 0,
      unsupported_events: 0,
    },
  };
}

export class RaceStateReducer {
  private readonly seenEventIds = new Set<string>();

  public constructor(private readonly state: RaceState) {}

  public apply(event: RaceEvent): void {
    if (this.seenEventIds.has(event.event_id)) {
      this.state.anomalies.duplicate_events += 1;
      return;
    }
    this.seenEventIds.add(event.event_id);

    this.state.sequence += 1;
    this.updateLatestSourceTime(event.source_time);

    switch (event.endpoint) {
      case "position":
        this.applyPosition(event);
        break;
      case "intervals":
        this.applyIntervals(event);
        break;
      case "laps":
        this.applyLap(event);
        break;
      case "stints":
        this.applyStint(event);
        break;
      case "pit":
        this.applyPit(event);
        break;
      case "race_control":
        this.applyRaceControl(event);
        break;
      case "weather":
        this.applyWeather(event);
        break;
      // Drivers are events. Ingest fetches the entry list (`drivers?meeting_key=` from
      // Friday practice, re-fetched at race discovery) and writes each row through the
      // same writer with endpoint `drivers`. The fold carries them; a swap arrives as a
      // new row; Driver stays a field inside RaceState, not a table. (HLD §7)
      case "drivers":
        this.applyDriver(event);
        break;
      default:
        this.state.anomalies.unsupported_events += 1;
    }

    this.updateDriverOrder();
  }

  public snapshot(): RaceState {
    return structuredClone(this.state);
  }

  private updateLatestSourceTime(sourceTime: string | null): void {
    const current = sourceMillis(this.state.latest_source_time);
    const incoming = sourceMillis(sourceTime);
    if (incoming !== null && (current === null || incoming >= current)) {
      this.state.latest_source_time = sourceTime;
    }
  }

  private getDriver(event: RaceEvent): DriverState | null {
    const driverNumber = numberValue(event.payload, "driver_number");
    if (driverNumber === null) {
      this.state.anomalies.missing_driver += 1;
      return null;
    }

    const key = String(driverNumber);
    const existing = this.state.drivers[key];
    if (existing !== undefined) {
      return existing;
    }

    const created = newDriver(driverNumber);
    this.state.drivers[key] = created;
    return created;
  }

  private acceptField(driver: DriverState, field: string, event: RaceEvent): boolean {
    const previousTime = driver.source_timestamps[field] ?? null;
    const previousMillis = sourceMillis(previousTime);
    const incomingMillis = sourceMillis(event.source_time);

    if (previousMillis !== null && incomingMillis !== null && incomingMillis < previousMillis) {
      this.state.anomalies.stale_updates += 1;
      return false;
    }

    if (event.source_time !== null) {
      driver.source_timestamps[field] = event.source_time;
    }
    return true;
  }

  private applyPosition(event: RaceEvent): void {
    const driver = this.getDriver(event);
    if (driver === null || !this.acceptField(driver, "position", event)) {
      return;
    }
    driver.position = numberValue(event.payload, "position");
  }

  private applyIntervals(event: RaceEvent): void {
    const driver = this.getDriver(event);
    if (driver === null || !this.acceptField(driver, "intervals", event)) {
      return;
    }
    driver.interval = numberValue(event.payload, "interval");
    driver.gap_to_leader = numberValue(event.payload, "gap_to_leader");
  }

  private applyLap(event: RaceEvent): void {
    const driver = this.getDriver(event);
    if (driver === null || !this.acceptField(driver, "lap", event)) {
      return;
    }
    driver.current_lap = numberValue(event.payload, "lap_number");
    driver.lap_duration = numberValue(event.payload, "lap_duration");
    driver.sector_durations = {
      sector_1: numberValue(event.payload, "duration_sector_1"),
      sector_2: numberValue(event.payload, "duration_sector_2"),
      sector_3: numberValue(event.payload, "duration_sector_3"),
    };
    driver.is_pit_out_lap = booleanValue(event.payload, "is_pit_out_lap");
    this.updateTyreAge(driver);
  }

  private applyStint(event: RaceEvent): void {
    const driver = this.getDriver(event);
    if (driver === null || !this.acceptField(driver, "tyre", event)) {
      return;
    }
    driver.tyre = {
      stint_number: numberValue(event.payload, "stint_number"),
      compound: stringValue(event.payload, "compound"),
      lap_start: numberValue(event.payload, "lap_start"),
      lap_end: numberValue(event.payload, "lap_end"),
      age_at_start: numberValue(event.payload, "tyre_age_at_start"),
      age: numberValue(event.payload, "tyre_age_at_start"),
    };
    this.updateTyreAge(driver);
  }

  private updateTyreAge(driver: DriverState): void {
    if (
      driver.current_lap === null ||
      driver.tyre.lap_start === null ||
      driver.tyre.age_at_start === null
    ) {
      return;
    }
    driver.tyre.age = driver.tyre.age_at_start + Math.max(0, driver.current_lap - driver.tyre.lap_start);
  }

  private applyPit(event: RaceEvent): void {
    const driver = this.getDriver(event);
    if (driver === null) {
      return;
    }
    const pitStop = { event_id: event.event_id, ...event.payload };
    driver.pit_stops.push(pitStop);
    driver.latest_pit_stop = pitStop;
  }

  private applyRaceControl(event: RaceEvent): void {
    const payload = event.payload;
    this.state.race_control.recent_messages.push({ event_id: event.event_id, payload });
    if (this.state.race_control.recent_messages.length > 100) {
      this.state.race_control.recent_messages.shift();
    }

    const category = stringValue(payload, "category");
    const flag = stringValue(payload, "flag");
    const message = stringValue(payload, "message")?.toUpperCase() ?? "";

    if (category === "SessionStatus") {
      this.state.race_control.session_status = stringValue(payload, "message");
    }

    if (category === "SafetyCar") {
      const isVirtual = message.startsWith("VSC") || message.includes("VIRTUAL SAFETY CAR");
      const isFull = message.startsWith("SAFETY CAR");
      if (message.includes("DEPLOYED")) {
        if (isVirtual) this.state.race_control.safety_car = "VSC";
        if (isFull) this.state.race_control.safety_car = "SC";
      } else if (message.includes("ENDING") || (isFull && message.includes("IN THIS LAP"))) {
        this.state.race_control.safety_car = null;
      }
    }

    if (flag !== null) {
      const scope = stringValue(payload, "scope") ?? "Track";
      const driverNumber = numberValue(payload, "driver_number");
      if (scope === "Driver" && driverNumber !== null) {
        if (flag === "CLEAR") {
          delete this.state.race_control.driver_flags[String(driverNumber)];
        } else {
          this.state.race_control.driver_flags[String(driverNumber)] = flag;
        }
        return;
      }

      const sector = numberValue(payload, "sector");
      const key = sector === null ? scope : `${scope}:${sector}`;
      if (flag === "CLEAR") {
        delete this.state.race_control.active_flags[key];
        this.state.race_control.current_flag = null;
      } else {
        this.state.race_control.active_flags[key] = flag;
        this.state.race_control.current_flag = flag;
      }
    }
  }

  private applyWeather(event: RaceEvent): void {
    const incoming = sourceMillis(event.source_time);
    const current = this.state.weather === null ? null : sourceMillis(stringValue(this.state.weather, "date"));
    if (incoming !== null && current !== null && incoming < current) {
      this.state.anomalies.stale_updates += 1;
      return;
    }
    this.state.weather = event.payload;
  }

  private applyDriver(event: RaceEvent): void {
    const driverNumber = numberValue(event.payload, "driver_number");
    if (driverNumber === null) {
      this.state.anomalies.missing_driver += 1;
      return;
    }

    const key = String(driverNumber);
    const existing = this.state.drivers[key];
    if (existing === undefined) {
      this.state.drivers[key] = newDriver(driverNumber, event.payload);
      return;
    }

    // Overwrite only the identity fields newDriver() copies from the payload;
    // timing state (position, interval, tyre, pit history, ...) is untouched.
    const refreshed = newDriver(driverNumber, event.payload);
    existing.full_name = refreshed.full_name;
    existing.name_acronym = refreshed.name_acronym;
    existing.team_name = refreshed.team_name;
    existing.team_colour = refreshed.team_colour;
  }

  private updateDriverOrder(): void {
    this.state.driver_order = Object.values(this.state.drivers)
      .filter((driver) => driver.position !== null)
      .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))
      .map((driver) => driver.driver_number);
  }
}
