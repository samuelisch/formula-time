import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makePush } from "../test/fixtures.ts";
import { BoardSourceProvider } from "./useBoardState.ts";
import { WeatherCard } from "./WeatherCard.tsx";

function renderWith(push: ReturnType<typeof makePush> | null): void {
  render(
    <BoardSourceProvider push={push}>
      <WeatherCard />
    </BoardSourceProvider>,
  );
}

describe("WeatherCard", () => {
  it("shows No weather data when weather is null", () => {
    renderWith(makePush({}, { weather: null }));
    expect(screen.getByText("No weather data")).toBeInTheDocument();
  });

  it("shows the air/track headline and the humidity/rainfall detail", () => {
    renderWith(
      makePush({}, { weather: { air_temperature: 24.5, track_temperature: 31.2, humidity: 55, rainfall: 0 } }),
    );
    expect(screen.getByText("24.5°C air / 31.2°C track")).toBeInTheDocument();
    expect(screen.getByText("Humidity 55% · Rainfall 0")).toBeInTheDocument();
  });
});
