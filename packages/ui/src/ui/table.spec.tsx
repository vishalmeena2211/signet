// The table carries the Work and Runs screens, so its behaviour is pinned:
// sorting must not mutate the caller's array (React Query hands us its cached
// one), rows must be keyboard-reachable, and an empty result must say so rather
// than render an empty frame.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./table.js";

interface Row {
  id: string;
  name: string;
  n: number;
}

const ROWS: Row[] = [
  { id: "a", name: "Cherry", n: 3 },
  { id: "b", name: "Apple", n: 1 },
  { id: "c", name: "Banana", n: 2 },
];

const COLUMNS: Column<Row>[] = [
  { key: "name", header: "Name", sort: (x, y) => x.name.localeCompare(y.name), render: (r) => r.name },
  { key: "n", header: "N", sort: (x, y) => x.n - y.n, render: (r) => String(r.n) },
  { key: "actions", header: "Actions", render: () => "—" },
];

function names(): string[] {
  return screen.getAllByRole("row").slice(1).map((tr) => tr.querySelectorAll("td")[0]?.textContent ?? "");
}

describe("DataTable", () => {
  it("does not mutate the array it was given when sorting", () => {
    // React Query's cached array is passed straight in; sorting in place would
    // silently reorder data for every other consumer of that query.
    const input = [...ROWS];
    const snapshot = input.map((r) => r.id);
    render(<DataTable rows={input} columns={COLUMNS} rowKey={(r) => r.id} initialSort={{ key: "name", dir: "asc" }} />);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });

  it("sorts ascending, then descending, on repeated header clicks", () => {
    render(<DataTable rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(names()).toEqual(["Apple", "Banana", "Cherry"]);
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(names()).toEqual(["Cherry", "Banana", "Apple"]);
  });

  it("leaves a column without a comparator unsortable", () => {
    render(<DataTable rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} />);
    // "Actions" is plain text, not a button, so it cannot be clicked to sort.
    expect(screen.queryByRole("button", { name: /Actions/ })).toBeNull();
  });

  it("opens the focused row on Enter, so the mouse is optional", () => {
    const onOpen = vi.fn();
    render(
      <DataTable
        rows={ROWS}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        onOpen={onOpen}
        initialSort={{ key: "name", dir: "asc" }}
      />,
    );
    const body = screen.getByLabelText(/arrow keys/i);
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "Enter" });
    // One step down from the first row of the ascending sort.
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: "Banana" }));
  });

  it("does not run off the end of the list with the arrow keys", () => {
    const onOpen = vi.fn();
    render(<DataTable rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} onOpen={onOpen} />);
    const body = screen.getByLabelText(/arrow keys/i);
    for (let i = 0; i < 10; i++) fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders the empty state instead of an empty frame", () => {
    render(
      <DataTable rows={[]} columns={COLUMNS} rowKey={(r) => r.id} empty={<div>Nothing here yet</div>} />,
    );
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
