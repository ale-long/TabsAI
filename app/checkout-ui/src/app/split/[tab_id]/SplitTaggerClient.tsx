"use client";

import { useState, useCallback } from "react";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from "@hello-pangea/dnd";
import type { Tab, ReceiptItem, DiscordMember } from "@/lib/types";

interface Props {
  tab: Tab;
  items: ReceiptItem[];
  token: string;
  guildMembers: DiscordMember[];
}

interface UserTag {
  id: string;
  discordId: string;
  label: string;
  avatarUrl: string | null;
  color: string;
}

const TAG_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-violet-500",
  "bg-cyan-500",
  "bg-pink-500",
  "bg-teal-500",
];

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const NON_ITEM_NAMES = ["Tax", "Tip"];

export default function SplitTaggerClient({ tab, items, token, guildMembers }: Props) {
  const taxAndTipItems = items.filter((i) => NON_ITEM_NAMES.includes(i.item_name));
  const [removedItemIds, setRemovedItemIds] = useState<Set<string>>(new Set());
  const [assignments, setAssignments] = useState<Record<string, string[]>>({});
  const [confirmStatus, setConfirmStatus] = useState<"idle" | "submitting" | "confirmed" | "error">("idle");

  const users: UserTag[] = guildMembers.map((m, i) => ({
    id: `user-${m.id}`,
    discordId: m.id,
    label: m.display_name,
    avatarUrl: m.avatar_url,
    color: TAG_COLORS[i % TAG_COLORS.length],
  }));

  const assignableItems = items.filter(
    (i) => !NON_ITEM_NAMES.includes(i.item_name) && !removedItemIds.has(i.id)
  );

  const removeItem = useCallback((itemId: string) => {
    setRemovedItemIds((prev) => new Set(prev).add(itemId));
    setAssignments((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }, []);

  const onDragEnd = useCallback(
    (result: DropResult) => {
      const { draggableId, destination } = result;
      if (!destination) return;

      const itemId = destination.droppableId;
      setAssignments((prev) => {
        const current = prev[itemId] || [];
        if (current.includes(draggableId)) return prev;
        return { ...prev, [itemId]: [...current, draggableId] };
      });
    },
    []
  );

  const removeAssignment = useCallback((itemId: string, userId: string) => {
    setAssignments((prev) => ({
      ...prev,
      [itemId]: (prev[itemId] || []).filter((uid) => uid !== userId),
    }));
  }, []);

  const getUserById = useCallback(
    (id: string) => users.find((u) => u.id === id),
    [users]
  );

  const subtotal = assignableItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  const taxAndTip = taxAndTipItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);

  const userItemTotals = users.reduce<Record<string, number>>((acc, user) => {
    acc[user.id] = 0;
    for (const item of assignableItems) {
      const assignedUsers = assignments[item.id] || [];
      if (assignedUsers.includes(user.id)) {
        acc[user.id] += (item.unit_price * item.quantity) / assignedUsers.length;
      }
    }
    return acc;
  }, {});

  const userTaxAndTip = users.reduce<Record<string, number>>((acc, user) => {
    const proportion = subtotal > 0 ? (userItemTotals[user.id] || 0) / subtotal : 0;
    acc[user.id] = taxAndTip * proportion;
    return acc;
  }, {});

  const userTotals = users.reduce<Record<string, number>>((acc, user) => {
    acc[user.id] = (userItemTotals[user.id] || 0) + (userTaxAndTip[user.id] || 0);
    return acc;
  }, {});

  const hasUnassignedItems = assignableItems.some(
    (item) => !assignments[item.id] || assignments[item.id].length === 0
  );

  const assignedUsers = users.filter((u) => (userItemTotals[u.id] || 0) > 0);

  const confirmSplit = async () => {
    setConfirmStatus("submitting");

    const payload = {
      tab_id: tab.id,
      token,
      assignments: assignedUsers.map((user) => ({
        discord_user_id: user.discordId,
        invitee_label: user.label,
        share_amount: Math.round(userTotals[user.id] || 0),
        item_ids: assignableItems
          .filter((item) => (assignments[item.id] || []).includes(user.id))
          .map((item) => item.id),
      })),
    };

    try {
      const res = await fetch("/api/confirm-split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setConfirmStatus("confirmed");
      } else {
        setConfirmStatus("error");
      }
    } catch {
      setConfirmStatus("error");
    }
  };

  if (confirmStatus === "confirmed") {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm rounded-2xl bg-surface p-8 text-center shadow-lg">
          <div className="mb-4 text-4xl">&#x2705;</div>
          <h1 className="mb-2 text-xl font-semibold">Split Confirmed</h1>
          <p className="text-muted">
            Assignments have been saved. Checkout links have been sent to Discord.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-lg px-4 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Split Your Tab</h1>
        <p className="mt-1 text-muted">
          Subtotal: <span className="font-semibold text-foreground">{formatCents(subtotal)}</span>
          {taxAndTip > 0 && (
            <>
              {" "}&middot; Tax &amp; Tip: <span className="font-semibold text-foreground">{formatCents(taxAndTip)}</span>
            </>
          )}
          {" "}&middot; Total: <span className="font-semibold text-foreground">{formatCents(tab.total_amount)}</span>
        </p>

        {/* Receipt Image */}
        {tab.receipt_storage_url && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-accent hover:text-accent-light">
              View Receipt
            </summary>
            <div className="mt-2 overflow-hidden rounded-xl border border-border">
              <img
                src={tab.receipt_storage_url}
                alt="Receipt"
                className="w-full"
              />
            </div>
          </details>
        )}
      </div>

      {/* Drag & Drop Area */}
      <DragDropContext onDragEnd={onDragEnd}>
        {/* Draggable Server Members */}
        {users.length > 0 ? (
          <Droppable droppableId="user-bank" direction="horizontal" isDropDisabled>
            {(provided) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
                className="mb-4 flex flex-wrap gap-2 rounded-xl bg-surface p-3 shadow-sm"
              >
                <p className="w-full text-xs font-medium text-muted mb-2">
                  Drag people onto items to assign them
                </p>
                {users.map((user, index) => (
                  <Draggable key={user.id} draggableId={user.id} index={index}>
                    {(provided, snapshot) => (
                      <span
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        {...provided.dragHandleProps}
                        className={`inline-flex cursor-grab items-center gap-1.5 rounded-full ${user.color} px-3 py-1.5 text-xs font-medium text-white shadow-sm ${
                          snapshot.isDragging ? "opacity-80 shadow-lg" : ""
                        }`}
                      >
                        {user.avatarUrl && (
                          <img
                            src={user.avatarUrl}
                            alt=""
                            className="h-4 w-4 rounded-full"
                          />
                        )}
                        {user.label}
                      </span>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        ) : (
          <div className="mb-4 rounded-xl bg-surface p-3 shadow-sm">
            <p className="text-xs text-muted">
              No server members found. Check that the bot has the Server Members Intent enabled.
            </p>
          </div>
        )}

        {/* Receipt Items */}
        <div className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Receipt Items
          </h2>
          {assignableItems.map((item) => {
            const assignedUserIds = assignments[item.id] || [];
            return (
              <Droppable key={item.id} droppableId={item.id}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={`rounded-xl border bg-surface p-4 transition-colors ${
                      snapshot.isDraggingOver
                        ? "border-accent bg-accent/5"
                        : "border-border"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{item.item_name}</p>
                        {item.quantity > 1 && (
                          <p className="text-xs text-muted">
                            Qty: {item.quantity}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold">
                          {formatCents(item.unit_price * item.quantity)}
                        </p>
                        <button
                          onClick={() => removeItem(item.id)}
                          className="rounded-lg p-1 text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                          aria-label={`Remove ${item.item_name}`}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {assignedUserIds.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {assignedUserIds.map((userId) => {
                          const user = getUserById(userId);
                          if (!user) return null;
                          return (
                            <span
                              key={userId}
                              className={`inline-flex items-center gap-1 rounded-full ${user.color} px-2 py-0.5 text-xs font-medium text-white`}
                            >
                              {user.label}
                              <button
                                onClick={() =>
                                  removeAssignment(item.id, userId)
                                }
                                className="hover:opacity-70"
                                aria-label={`Unassign ${user.label}`}
                              >
                                &times;
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    <div className="hidden">{provided.placeholder}</div>
                  </div>
                )}
              </Droppable>
            );
          })}
        </div>

        {/* Tax & Tip Info */}
        {taxAndTip > 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-border bg-surface/50 p-4">
            <p className="text-xs font-medium text-muted uppercase tracking-wide mb-2">
              Auto-distributed by share
            </p>
            {taxAndTipItems.map((item) => (
              <div key={item.id} className="flex items-center justify-between text-sm">
                <span className="text-muted">{item.item_name}</span>
                <span className="font-medium">{formatCents(item.unit_price * item.quantity)}</span>
              </div>
            ))}
          </div>
        )}
      </DragDropContext>

      {/* Summary & Checkout Links */}
      {assignedUsers.length > 0 && (
        <div className="mt-6 rounded-xl bg-surface p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
            Summary
          </h2>
          <div className="space-y-3">
            {assignedUsers.map((user) => (
              <div key={user.id} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-3 w-3 rounded-full ${user.color}`}
                  />
                  <div>
                    <span className="text-sm font-medium">{user.label}</span>
                    {taxAndTip > 0 && (userItemTotals[user.id] || 0) > 0 && (
                      <p className="text-xs text-muted">
                        Items {formatCents(Math.round(userItemTotals[user.id]))} + Tax &amp; Tip {formatCents(Math.round(userTaxAndTip[user.id]))}
                      </p>
                    )}
                  </div>
                </div>
                <span className="text-sm font-semibold">
                  {formatCents(Math.round(userTotals[user.id] || 0))}
                </span>
              </div>
            ))}
          </div>

          {/* Confirm Button */}
          <div className="mt-4 pt-4 border-t border-border">
            {confirmStatus === "error" && (
              <p className="mb-2 text-sm text-danger">
                Failed to confirm. Please try again.
              </p>
            )}
            <button
              onClick={confirmSplit}
              disabled={
                users.length === 0 ||
                hasUnassignedItems ||
                confirmStatus === "submitting"
              }
              className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-light disabled:opacity-50"
            >
              {confirmStatus === "submitting"
                ? "Confirming..."
                : hasUnassignedItems
                  ? "Assign all items to confirm"
                  : "Confirm Split"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
