"use client";
/**
 * S12 users and invitations (F09) with the M11 invite dialog (Design §4.5, §4.9; SA §4.2;
 * US-01/02/15/21; TASK-148).
 *
 * - Superadmins only: other roles see a notice and no request is made.
 * - Users tab:
 *   - server-paged list (20 per page), with search and filters for role and status;
 *   - role changes and activation go through M09 and are sent with If-Match;
 *   - the API's protection of the last administrator (409) is shown as a blocked reason, never as
 *     a success;
 *   - a 403 reloads the signed-in user's own permissions and the list.
 * - Invitations tab: server-paged list with a status filter, showing status (active, used, revoked,
 *   expired), creation and expiry. Revoke is offered for active codes only, through M09.
 * - M11 creates an invitation (1–720 hours, default 168) with an Idempotency-Key.
 *   - The one-time code is shown only in the dialog, with "Copy code" and a selectable field for
 *     manual copying when the clipboard is unavailable. It is never stored, logged or emailed,
 *     and closing the dialog forgets it.
 *   - A lost or replayed response says the outcome is unknown and refreshes the list, so the admin
 *     can check the invitation there, revoke it and create a new one.
 * States per tab:
 * - loading;
 * - empty: no matches / no invitations;
 * - ideal;
 * - partial: used, expired or protected entries;
 * - error: rejected change, with a refreshed list.
 */
import { Copy, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { USER_ROLES } from "@kabuki-neko/shared/constants/game";
import {
  invitationCreatedSchema,
  invitationRevokedSchema,
  invitationStatuses,
  invitationsPageSchema,
  userSchema,
  usersPageSchema,
  type Invitation,
  type User,
} from "@kabuki-neko/shared/schemas/users.schema";
import { ActionButton } from "@/components/ui/action-button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { ConfirmDialog, useConfirmAction } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { ModalSheet } from "@/components/ui/modal-sheet";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusNotice } from "@/components/ui/status-notice";
import { ApiError, apiErrorMessageKey, createLatestRequest } from "@/lib/api-client";
import { useAuth } from "@/providers/auth-provider";
import { useLocale } from "@/providers/locale-provider";

/** Users per page (SA paging default). */
const USERS_PAGE = 20;
/** Invitations per page (SA paging default). */
const INVITES_PAGE = 20;
/** Filter value meaning "no filter" (an empty value would collide with the select placeholder). */
const ALL = "all";

/** Clipboard writer (tests); null when the browser offers none. */
export type ClipboardWriter = ((text: string) => Promise<void>) | null;

/** Default clipboard writer. */
function defaultClipboard(): ClipboardWriter {
  return typeof navigator !== "undefined" && navigator.clipboard
    ? (text) => navigator.clipboard.writeText(text)
    : null;
}

/** List state. */
type ListState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; items: T[]; totalPages: number };

/** Props of {@link UserInvites}. */
export interface UserInvitesProps {
  /** Clipboard writer (tests); defaults to the browser clipboard. */
  clipboard?: ClipboardWriter;
}

/** S12: users and invitations. */
export function UserInvites({ clipboard }: UserInvitesProps) {
  const { t, ensureNamespaces } = useLocale();
  const { user } = useAuth();
  const [tab, setTab] = useState<"users" | "invitations">("users");

  useEffect(() => {
    void ensureNamespaces(["admin", "validation", "media", "reports"]);
  }, [ensureNamespaces]);

  if (!user)
    return (
      <p role="status" className="text-small text-muted-foreground">
        {t("admin.inventory.s12.loading")}
      </p>
    );
  if (user.role !== "SUPERADMIN")
    return (
      <p role="alert" className="text-body">
        {t("validation.errors.forbidden")}
      </p>
    );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title font-bold">{t("admin.inventory.f09.title")}</h1>
      <ChoiceGroup
        mode="tabs"
        label={t("admin.inventory.f09.title")}
        hideLabel
        items={[
          { id: "users", label: t("admin.users.title") },
          { id: "invitations", label: t("admin.invitations.title") },
        ]}
        selected={tab}
        onSelect={(id) => setTab(id === "invitations" ? "invitations" : "users")}
      />
      {tab === "users" ? (
        <UsersPanel selfId={user.id} />
      ) : (
        <InvitationsPanel clipboard={clipboard === undefined ? defaultClipboard() : clipboard} />
      )}
    </div>
  );
}

/** A pending access change awaiting M09. */
type AccessChange = { user: User; patch: { role: User["role"] } | { isActive: boolean } };

/** Users list with search, filters and access changes. */
function UsersPanel({ selfId }: { selfId: string }) {
  const { t } = useLocale();
  const { api, reloadPrincipal } = useAuth();
  const base = useId();
  const [state, setState] = useState<ListState<User>>({ status: "loading" });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchText, setSearchText] = useState("");
  const [role, setRole] = useState<string>(ALL);
  const [active, setActive] = useState<string>(ALL);
  const [version, setVersion] = useState(0);
  const [change, setChange] = useState<AccessChange | null>(null);
  const [rejected, setRejected] = useState(false);
  const latest = useRef(createLatestRequest());

  useEffect(() => {
    let alive = true;
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    latest.current
      .run((signal) =>
        api.request({
          path: "/users",
          query: {
            page,
            limit: USERS_PAGE,
            ...(search ? { search } : {}),
            ...(role !== ALL ? { role } : {}),
            ...(active !== ALL ? { isActive: active } : {}),
          },
          schema: usersPageSchema,
          signal,
        }),
      )
      .then(
        (result) => {
          if (!alive || result.stale) return;
          const { items, meta } = result.value.data;
          setState({ status: "ready", items, totalPages: meta.totalPages });
        },
        (error: unknown) => alive && setState({ status: "error", error }),
      );
    return () => {
      alive = false;
    };
  }, [api, page, search, role, active, version]);

  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const confirm = useConfirmAction({
    run: async () => {
      if (!change) return;
      try {
        await api.request({
          method: "PATCH",
          path: `/users/${change.user.id}`,
          body: change.patch,
          ifMatch: change.user.revision,
          schema: userSchema,
        });
        setRejected(false);
      } catch (error) {
        if (error instanceof ApiError && error.code === "FORBIDDEN") {
          setRejected(true);
          void reloadPrincipal();
        }
        refresh();
        throw error;
      }
    },
    onDone: refresh,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearch(searchText.trim());
    setPage(1);
  };

  const roleLabel = (value: User["role"]) =>
    value === "SUPERADMIN" ? t("admin.users.superadmin") : t("admin.users.creator");

  let body;
  if (state.status === "loading")
    body = <SkeletonBlock layout="rows" count={4} label={t("admin.inventory.s12.loading")} />;
  else if (state.status === "error")
    body = (
      <StatusNotice
        tone="error"
        message={t("admin.inventory.s12.error")}
        correlationId={state.error instanceof ApiError ? state.error.correlationId : null}
        action={{ label: t("common.actions.retry"), onAction: refresh }}
      />
    );
  else if (state.items.length === 0)
    body = (
      <p role="status" className="rounded-md border border-dashed border-border p-4">
        {t("admin.inventory.s12.empty")}
      </p>
    );
  else
    body = (
      <ul className="flex flex-col gap-2">
        {state.items.map((item) => {
          const nextRole = item.role === "SUPERADMIN" ? "CREATOR" : "SUPERADMIN";
          return (
            <li
              key={item.id}
              data-user-id={item.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
            >
              <div className="flex min-w-0 flex-1 basis-48 flex-col">
                <span className="font-semibold break-words">{item.name}</span>
                <span className="text-small break-words text-muted-foreground">{item.email}</span>
              </div>
              <StatusBadge tone="info" label={roleLabel(item.role)} />
              <StatusBadge
                tone={item.isActive ? "success" : "neutral"}
                label={item.isActive ? t("admin.users.active") : t("admin.users.inactive")}
              />
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  variant="secondary"
                  label={t("admin.users.changeRole")}
                  accessibleName={`${t("admin.users.changeRole")}: ${item.name}`}
                  onPress={() => {
                    setChange({ user: item, patch: { role: nextRole } });
                    confirm.request();
                  }}
                />
                <ActionButton
                  variant={item.isActive ? "ghost" : "secondary"}
                  label={item.isActive ? t("admin.users.deactivate") : t("admin.users.activate")}
                  accessibleName={`${item.isActive ? t("admin.users.deactivate") : t("admin.users.activate")}: ${item.name}`}
                  disabled={item.id === selfId && item.isActive}
                  {...(item.id === selfId && item.isActive
                    ? { disabledReason: t("validation.errors.forbidden") }
                    : {})}
                  onPress={() => {
                    setChange({ user: item, patch: { isActive: !item.isActive } });
                    confirm.request();
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    );

  const pending = change
    ? "role" in change.patch
      ? `${t("admin.users.changeRole")}: ${roleLabel(change.patch.role)}`
      : change.patch.isActive
        ? t("admin.users.activate")
        : t("common.confirm.deactivateUser")
    : "";

  return (
    <section aria-labelledby={`${base}-users`} className="flex flex-col gap-4">
      <h2 id={`${base}-users`} className="sr-only">
        {t("admin.users.title")}
      </h2>
      {rejected && <StatusNotice tone="error" message={t("admin.inventory.s12.error")} />}
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <form role="search" onSubmit={submit} className="flex flex-1 items-end gap-2">
          <div className="min-w-0 flex-1">
            <FormField
              label={t("admin.users.search")}
              value={searchText}
              onChange={setSearchText}
            />
          </div>
          <ActionButton type="submit" variant="secondary" label={t("common.actions.search")} />
        </form>
        <FormField
          kind="select"
          label={t("admin.users.role")}
          value={role}
          options={[
            { value: ALL, label: t("media.library.all") },
            ...USER_ROLES.map((value) => ({ value, label: roleLabel(value) })),
          ]}
          onChange={(value) => {
            setRole(value);
            setPage(1);
          }}
        />
        <FormField
          kind="select"
          label={t("admin.users.active")}
          value={active}
          options={[
            { value: ALL, label: t("media.library.all") },
            { value: "true", label: t("admin.users.active") },
            { value: "false", label: t("admin.users.inactive") },
          ]}
          onChange={(value) => {
            setActive(value);
            setPage(1);
          }}
        />
      </div>
      <p className="text-small text-muted-foreground">{t("admin.users.lastSuperadmin")}</p>
      {body}
      {state.status === "ready" && state.totalPages > 1 && (
        <Pager page={page} totalPages={state.totalPages} onPage={setPage} />
      )}
      <ConfirmDialog
        controller={confirm}
        impact={pending}
        targetName={change?.user.name ?? null}
        confirmLabel={t("common.actions.confirm")}
        destructive={change !== null && "isActive" in change.patch && !change.patch.isActive}
      />
    </section>
  );
}

/** Previous/next pagination. */
function Pager({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  const { t } = useLocale();
  return (
    <nav
      aria-label={t("common.pagination.label")}
      className="flex flex-wrap items-center justify-center gap-3"
    >
      <ActionButton
        variant="secondary"
        label={t("common.pagination.previous")}
        disabled={page <= 1}
        onPress={() => onPage(page - 1)}
      />
      <span aria-current="page" className="text-label tabular-nums">
        {t("common.pagination.pageOf", { page, totalPages })}
      </span>
      <ActionButton
        variant="secondary"
        label={t("common.pagination.next")}
        disabled={page >= totalPages}
        onPress={() => onPage(page + 1)}
      />
    </nav>
  );
}

/** Status label key of an invitation. */
const STATUS_KEY: Record<Invitation["status"], string> = {
  ACTIVE: "admin.invitations.active",
  USED: "admin.invitations.used",
  REVOKED: "admin.invitations.revoked",
  EXPIRED: "admin.invitations.expired",
};

/** Invitations list, revoke and the M11 create dialog. */
function InvitationsPanel({ clipboard }: { clipboard: ClipboardWriter }) {
  const { t, formatDate } = useLocale();
  const { api } = useAuth();
  const base = useId();
  const [state, setState] = useState<ListState<Invitation>>({ status: "loading" });
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(ALL);
  const [version, setVersion] = useState(0);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    api
      .request({
        path: "/users/invitations",
        query: { page, limit: INVITES_PAGE, ...(status !== ALL ? { status } : {}) },
        schema: invitationsPageSchema,
      })
      .then(
        ({ data }) =>
          alive &&
          setState({ status: "ready", items: data.items, totalPages: data.meta.totalPages }),
        (error: unknown) => alive && setState({ status: "error", error }),
      );
    return () => {
      alive = false;
    };
  }, [api, page, status, version]);

  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const confirmRevoke = useConfirmAction({
    run: async () => {
      if (!revoking) return;
      try {
        await api.request({
          method: "DELETE",
          path: `/users/invitations/${revoking.id}`,
          schema: invitationRevokedSchema,
        });
      } catch (error) {
        refresh();
        throw error;
      }
    },
    onDone: refresh,
  });

  const date = (value: number) => formatDate(value, { dateStyle: "medium", timeStyle: "short" });

  let body;
  if (state.status === "loading")
    body = <SkeletonBlock layout="rows" count={3} label={t("admin.inventory.f09.loading")} />;
  else if (state.status === "error")
    body = (
      <StatusNotice
        tone="error"
        message={t("admin.inventory.f09.error")}
        action={{ label: t("common.actions.retry"), onAction: refresh }}
      />
    );
  else if (state.items.length === 0)
    body = (
      <p role="status" className="rounded-md border border-dashed border-border p-4">
        {t("admin.inventory.f09.empty")}
      </p>
    );
  else
    body = (
      <ul className="flex flex-col gap-2">
        {state.items.map((invite) => (
          <li
            key={invite.id}
            data-invite-status={invite.status}
            className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-small"
          >
            <StatusBadge
              tone={invite.status === "ACTIVE" ? "success" : "neutral"}
              label={t(STATUS_KEY[invite.status])}
            />
            <span className="min-w-0 flex-1 basis-48">
              {t("admin.invitations.expiresAt", { expiresAt: invite.expiresAt })}
            </span>
            <span className="text-muted-foreground">{date(invite.createdAt)}</span>
            {invite.status === "ACTIVE" && (
              <ActionButton
                variant="ghost"
                label={t("admin.invitations.revoke")}
                accessibleName={`${t("admin.invitations.revoke")}: ${date(invite.createdAt)}`}
                onPress={() => {
                  setRevoking(invite);
                  confirmRevoke.request();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    );

  const inactive =
    state.status === "ready" && state.items.some((invite) => invite.status !== "ACTIVE");

  return (
    <section aria-labelledby={`${base}-invites`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id={`${base}-invites`} className="text-title-sm font-semibold">
          {t("admin.invitations.title")}
        </h2>
        <ActionButton
          icon={<Plus />}
          label={t("admin.invitations.create")}
          onPress={() => setCreateOpen(true)}
        />
      </div>
      <FormField
        kind="select"
        label={t("reports.table.status")}
        value={status}
        options={[
          { value: ALL, label: t("media.library.all") },
          ...invitationStatuses.map((value) => ({ value, label: t(STATUS_KEY[value]) })),
        ]}
        onChange={(value) => {
          setStatus(value);
          setPage(1);
        }}
      />
      {inactive && (
        <p className="text-small text-muted-foreground">{t("admin.inventory.f09.partial")}</p>
      )}
      {body}
      {state.status === "ready" && state.totalPages > 1 && (
        <Pager page={page} totalPages={state.totalPages} onPage={setPage} />
      )}
      <ConfirmDialog
        controller={confirmRevoke}
        impact={t("common.confirm.revokeInvite")}
        targetName={revoking ? date(revoking.createdAt) : null}
        confirmLabel={t("admin.invitations.revoke")}
      />
      <InviteDialog
        open={createOpen}
        clipboard={clipboard}
        onClose={() => setCreateOpen(false)}
        onSettled={refresh}
      />
    </section>
  );
}

/** M11: create an invitation and show its one-time code. */
function InviteDialog({
  open,
  clipboard,
  onClose,
  onSettled,
}: {
  open: boolean;
  clipboard: ClipboardWriter;
  onClose: () => void;
  onSettled: () => void;
}) {
  const { t } = useLocale();
  const { api } = useAuth();
  const codeId = useId();
  const [hours, setHours] = useState("168");
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<{ code: string; expiresAt: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  // Each opening starts fresh; the code is forgotten when the dialog closes.
  useEffect(() => {
    if (!open) return;
    setHours("168");
    setCreated(null);
    setProblem(null);
    setCopy("idle");
  }, [open]);

  const create = async () => {
    const value = Number(hours);
    if (!Number.isInteger(value) || value < 1 || value > 720) {
      setProblem(t("validation.errors.outOfRange"));
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const { data } = await api.request({
        method: "POST",
        path: "/users/invitations",
        body: { expiresInHours: value },
        idempotencyKey: crypto.randomUUID(),
        schema: invitationCreatedSchema,
      });
      setCreated({ code: data.inviteCode, expiresAt: data.invitation.expiresAt });
    } catch (error) {
      setProblem(
        error instanceof ApiError && !error.uncertain && error.code !== "INVITE_CODE_ALREADY_ISSUED"
          ? t(apiErrorMessageKey(error.code))
          : t("admin.invitations.unknownOutcome"),
      );
    } finally {
      setPending(false);
      onSettled();
    }
  };

  const copyCode = async () => {
    if (!created) return;
    if (!clipboard) {
      setCopy("failed");
      return;
    }
    try {
      await clipboard(created.code);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <ModalSheet
      open={open}
      title={t("admin.inventory.m11.title")}
      pending={pending}
      onCloseRequest={onClose}
      error={problem ?? undefined}
      footer={
        created ? (
          <ActionButton variant="secondary" label={t("common.actions.close")} onPress={onClose} />
        ) : (
          <>
            <ActionButton
              variant="secondary"
              label={t("common.actions.cancel")}
              onPress={onClose}
            />
            <ActionButton
              label={t("admin.invitations.create")}
              pending={pending}
              onPress={() => void create()}
            />
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-3">
          <p>{t("admin.inventory.m11.ideal")}</p>
          <p className="text-small font-semibold text-warning">
            {t("admin.invitations.oneTimeCode")}
          </p>
          <label htmlFor={codeId} className="text-label font-semibold">
            {t("admin.invitations.code")}
          </label>
          <input
            id={codeId}
            readOnly
            value={created.code}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-small"
          />
          <p className="text-small text-muted-foreground">
            {t("admin.invitations.expiresAt", { expiresAt: created.expiresAt })}
          </p>
          <ActionButton
            variant="secondary"
            icon={<Copy />}
            label={t("admin.invitations.copy")}
            onPress={() => void copyCode()}
            className="self-start"
          />
          <p role="status" aria-live="polite" className="text-small empty:hidden">
            {copy === "copied" ? t("admin.invitations.copied") : ""}
          </p>
          {copy === "failed" && (
            <p role="alert" className="text-small text-danger">
              {t("admin.invitations.copyFailed")}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-small text-muted-foreground">{t("admin.inventory.m11.empty")}</p>
          <FormField
            kind="number"
            label={t("admin.invitations.expiresInHours")}
            value={hours}
            min={1}
            max={720}
            step={1}
            onChange={setHours}
          />
        </div>
      )}
    </ModalSheet>
  );
}
