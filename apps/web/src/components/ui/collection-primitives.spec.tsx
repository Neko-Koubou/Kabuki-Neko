/**
 * TASK-121 coverage for B09 ContentCard and B10 DataCollection: one unambiguous heading link with
 * actions outside it, full long/CJK titles kept for assistive technology, cover fallback, card
 * loading/missing/error states; controlled table + mobile cards with caption, sortable headers
 * (aria-sort, keyboard), row identity by key, known-total and unknown-total pagination (never "0
 * results"), loading skeleton, stale rows while refetching or after a failed refresh, error without
 * data (never the empty message) and the empty state with its action.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "@/test/locale";
import { ContentCard } from "./content-card";
import { DataCollection, type CollectionColumn } from "./data-collection";

const LONG_CJK_TITLE =
  "日本の歴史と文化についての非常に長いクイズタイトル：江戸時代から明治維新まで、そして現代に至るまでの出来事を網羅する総合問題集";

describe("B09 ContentCard", () => {
  it("has one heading link, separate actions, metadata and the full long title", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    renderWithLocale(
      <ContentCard
        heading={LONG_CJK_TITLE}
        href="/dashboard/quizzes/q-1"
        metadata={[
          { label: "Questions", value: "12" },
          { label: "Updated", value: "Nov 8, 2026" },
        ]}
        actions={
          <button type="button" onClick={onEdit}>
            Edit
          </button>
        }
      />,
    );
    const card = screen.getByRole("article");
    const links = within(card).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName(LONG_CJK_TITLE);
    expect(links[0]).toHaveAttribute("href", "/dashboard/quizzes/q-1");
    expect(within(card).getByRole("heading", { level: 3 })).toContainElement(links[0] ?? null);
    const edit = within(card).getByRole("button", { name: "Edit" });
    expect(links[0]).not.toContainElement(edit);
    expect(within(card).getByText(LONG_CJK_TITLE)).toHaveClass("line-clamp-2");
    expect(within(card).getByText("Questions").tagName).toBe("DT");
    await user.click(edit);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("falls back when the cover fails and supports a button heading", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderWithLocale(
      <ContentCard heading="Capitals" onOpen={onOpen} media={{ src: "/media/broken.webp" }} />,
    );
    const image = screen.getByRole("presentation");
    fireEvent.error(image);
    expect(screen.getByText("The cover image isn't available.")).toBeInTheDocument();
    expect(screen.queryByRole("presentation")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Capitals" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders loading, missing and error states", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = renderWithLocale(<ContentCard state="loading" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading item…");
    rerender(<ContentCard state="missing" />);
    expect(screen.getByText("This item no longer exists.")).toBeInTheDocument();
    rerender(<ContentCard state="error" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This item couldn't load.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

interface Row {
  id: string;
  title: string;
  players: number;
}
const columns: CollectionColumn<Row>[] = [
  { id: "title", header: "Title", cell: (row) => row.title, sortable: true, primary: true },
  { id: "players", header: "Players", cell: (row) => row.players, sortable: true, align: "end" },
];
const rows: Row[] = [
  { id: "r-7", title: LONG_CJK_TITLE, players: 31 },
  { id: "r-2", title: "World capitals", players: 12 },
];

/** Table element of the rendered collection (desktop layout). */
function table() {
  return screen.getByRole("table", { name: "Recent sessions" });
}

describe("B10 DataCollection", () => {
  it("renders a captioned table and mobile cards, sorts by keyboard and keys rows by id", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    const { rerender } = renderWithLocale(
      <DataCollection
        caption="Recent sessions"
        items={rows}
        columns={columns}
        rowKey={(row) => row.id}
        page={1}
        pageCount={1}
        totalCount={2}
        sort={{ column: "players", direction: "descending" }}
        onSort={onSort}
        onPage={() => {}}
      />,
    );
    expect(screen.getByText("2 results")).toBeInTheDocument();
    const headers = within(table()).getAllByRole("columnheader");
    expect(headers[0]).toHaveAttribute("aria-sort", "none");
    expect(headers[1]).toHaveAttribute("aria-sort", "descending");
    expect(within(table()).getByRole("cell", { name: LONG_CJK_TITLE })).toHaveClass("break-words");

    const titleSort = within(table()).getByRole("button", { name: "Title" });
    titleSort.focus();
    await user.keyboard("{Enter}");
    expect(onSort).toHaveBeenCalledWith("title");

    // Mobile cards: header/value pairs, titled by the primary column.
    const cards = screen.getByRole("list", { name: "Recent sessions" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(2);
    expect(within(cards).getAllByText("Players")).toHaveLength(2);

    // Row identity follows rowKey, not position.
    const firstRow = within(table()).getAllByRole("row")[1];
    rerender(
      <DataCollection
        caption="Recent sessions"
        items={[...rows].reverse()}
        columns={columns}
        rowKey={(row) => row.id}
        page={1}
        pageCount={1}
        onPage={() => {}}
      />,
    );
    expect(within(table()).getAllByRole("row")[2]).toBe(firstRow);
  });

  it("paginates with a known total and with an unknown total (never 0 results)", async () => {
    const user = userEvent.setup();
    const onPage = vi.fn();
    const { rerender } = renderWithLocale(
      <DataCollection
        caption="Recent sessions"
        items={rows}
        columns={columns}
        rowKey={(row) => row.id}
        page={2}
        pageCount={5}
        onPage={onPage}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(nav).toHaveTextContent("Page 2 of 5");
    await user.click(within(nav).getByRole("button", { name: "Previous page" }));
    await user.click(within(nav).getByRole("button", { name: "Next page" }));
    expect(onPage.mock.calls).toEqual([[1], [3]]);

    rerender(
      <DataCollection
        caption="Recent sessions"
        items={rows}
        columns={columns}
        rowKey={(row) => row.id}
        page={1}
        pageCount={null}
        hasNextPage
        totalCount={null}
        onPage={onPage}
      />,
    );
    const unknown = screen.getByRole("navigation", { name: "Pagination" });
    expect(unknown).toHaveTextContent("1");
    expect(unknown).not.toHaveTextContent("of");
    expect(screen.queryByText(/results?$/u)).not.toBeInTheDocument();
    expect(within(unknown).getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(within(unknown).getByRole("button", { name: "Next page" })).toBeEnabled();

    rerender(
      <DataCollection
        caption="Recent sessions"
        items={rows}
        columns={columns}
        rowKey={(row) => row.id}
        page={3}
        pageCount={null}
        hasNextPage={false}
        onPage={onPage}
      />,
    );
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it("shows loading, stale, error and empty states honestly", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const base = {
      caption: "Recent sessions",
      columns,
      rowKey: (row: Row) => row.id,
      page: 1,
      pageCount: 1,
      onPage: () => {},
      onRetry,
    };
    const { rerender, container } = renderWithLocale(
      <DataCollection {...base} items={null} pending />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading results…");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    // Refetching with data: rows stay, labelled stale and busy.
    rerender(<DataCollection {...base} items={rows} pending />);
    expect(table()).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("May be out of date");
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();

    // Failed refresh with data: older rows stay with an alert and Retry.
    rerender(<DataCollection {...base} items={rows} error={new Error("503")} />);
    expect(table()).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This list couldn't be refreshed. You're seeing older data.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    // Failure without data: an error, never the empty message.
    rerender(<DataCollection {...base} items={[]} error={new Error("503")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This item couldn't load.");
    expect(screen.queryByText(/No results/u)).not.toBeInTheDocument();

    rerender(
      <DataCollection
        {...base}
        items={[]}
        emptyAction={<button type="button">Clear filters</button>}
      />,
    );
    expect(
      screen.getByText("No results. Try changing or clearing your filters."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });
});
