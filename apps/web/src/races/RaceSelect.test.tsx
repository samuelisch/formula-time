import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RaceIndexEntry } from "./api.ts";
import { RaceSelect } from "./RaceSelect.tsx";

const races: RaceIndexEntry[] = [
  {
    session_key: 11361,
    name: "Race",
    country: "Italy",
    date_start: "2026-09-06T13:00:00.000Z",
    date_end: "2026-09-06T15:00:00.000Z",
    total_laps: 53,
    exported_at: "2026-09-06T15:10:00.000Z",
  },
  {
    session_key: 11200,
    name: "Race",
    country: "Netherlands",
    date_start: "2026-08-30T13:00:00.000Z",
    date_end: "2026-08-30T15:00:00.000Z",
    total_laps: 72,
    exported_at: "2026-08-30T15:10:00.000Z",
  },
];

describe("RaceSelect", () => {
  it("lists the current session first, labelled with its status, then the races newest first", () => {
    render(
      <RaceSelect
        current={{ sessionKey: "9999", label: "Japan · Race", status: "live" }}
        races={races}
        value="9999"
        onChange={vi.fn()}
      />,
    );

    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((option) => option.value)).toEqual(["9999", "11361", "11200"]);
    expect(options.at(0)?.textContent).toContain("Live now");
  });

  it("labels the current session Upcoming or Finished per its status", () => {
    const { rerender } = render(
      <RaceSelect current={{ sessionKey: "9999", label: "Japan · Race", status: "upcoming" }} races={[]} value="9999" onChange={vi.fn()} />,
    );
    expect(screen.getByRole("option", { name: /Upcoming/ })).toBeInTheDocument();

    rerender(<RaceSelect current={{ sessionKey: "9999", label: "Japan · Race", status: "finished" }} races={[]} value="9999" onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: /Finished/ })).toBeInTheDocument();
  });

  it("deduplicates a race matching the current session's key", () => {
    render(
      <RaceSelect
        current={{ sessionKey: "11361", label: "Italy · Race", status: "finished" }}
        races={races}
        value="11361"
        onChange={vi.fn()}
      />,
    );

    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((option) => option.value)).toEqual(["11361", "11200"]);
  });

  it("renders only the historical races when there is no current session", () => {
    render(<RaceSelect current={null} races={races} value="11361" onChange={vi.fn()} />);

    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((option) => option.value)).toEqual(["11361", "11200"]);
  });

  it("calls onChange with the selected session_key", () => {
    const onChange = vi.fn();
    render(
      <RaceSelect current={{ sessionKey: "9999", label: "Japan · Race", status: "live" }} races={races} value="9999" onChange={onChange} />,
    );

    const select = screen.getByRole("combobox");
    // fireEvent.change is the RTL-idiomatic way to drive a <select>, but
    // this repo favours userEvent elsewhere; a plain change event keeps
    // this test dependency-light since only the value matters here.
    (select as HTMLSelectElement).value = "11200";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith("11200");
  });
});
