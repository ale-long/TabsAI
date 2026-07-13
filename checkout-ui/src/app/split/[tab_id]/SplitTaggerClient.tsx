"use client";

import { useState, useCallback } from "react";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from "@hello-pangea/dnd";
import type { Tab, ReceiptItem } from "@/lib/types";

interface Props {
  tab: Tab;
  items: ReceiptItem[];
  token: string;
}

interface UserTag {
  id: string;
  label: string;
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

export default function SplitTaggerClient({ tab, items, token }: Props) {
  const [users, setUsers] = useState<UserTag[]>([]);
  const [newUserName, setNewUserName] = useState("");
  const [assignments, setAssignments] = useState<Record<string, string[]>>({});
  const [linksCopied, setLinksCopied] = useState<Record<string, boolean>>({});
  const [confirmStatus, setConfirmStatus] = useState<"idle" | "submitting" | "confirmed" | "error">("idle");

  const addUser = useCallback(() => {
    const name = newUserName.trim();
    if (!name || users.some((u) => u.label === name)) return;
    setUsers((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        label: name,
        color: TAG_COLORS[prev.length % TAG_COLORS.length],
      },
    ]);
    setNewUserName("");
  }, [newUserName, users]);

  const removeUser = useCallback((userId: string) => {
    setUsers((prev) => prev.filter((u) => u.id !== userId));
    setAssignments((prev) => {
      const next = { ...prev };
      for (const itemId of Object.keys(next)) {
        next[itemId] = next[itemId].filter((uid) => uid !== userId);
      }
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

  // Calculate per-user totals
  const userTotals = users.reduce<Record<string, number>>((acc, user) => {
    acc[user.id] = 0;
    for (const item of items) {
      const assignedUsers = assignments[item.id] || [];
      if (assignedUsers.includes(user.id)) {
        acc[user.id] += (item.unit_price * item.quantity) / assignedUsers.length;
      }
    }
    return acc;
  }, {});

  const generateCheckoutLink = (user: UserTag) => {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    return `${base}/split/${tab.id}?token=${token}&invitee=${encodeURIComponent(user.label)}`;
  };

  const copyLink = async (user: UserTag) => {
    const link = generateCheckoutLink(user);
    await navigator.clipboard.writeText(link);
    setLinksCopied((prev) => ({ ...prev, [user.id]: true }));
    setTimeout(() => {
      setLinksCopied((prev) => ({ ...prev, [user.id]: false }));
    }, 2000);
  };

  const hasUnassignedItems = items.some(
    (item) => !assignments[item.id] || assignments[item.id].length === 0
  );

  const confirmSplit = async () => {
    setConfirmStatus("submitting");

    const payload = {
      tab_id: tab.id,
      token,
      assignments: users.map((user) => ({
        invitee_label: user.label,
        share_amount: Math.round(userTotals[user.id] || 0),
        item_ids: items
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
          Total: <span className="font-semibold text-foreground">{formatCents(tab.total_amount)}</span>
        </p>
      </div>

      {/* Add Users Section */}
      <div className="mb-6 rounded-xl bg-surface p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          People
        </h2>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Add a person..."
            value={newUserName}
            onChange={(e) => setNewUserName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addUser()}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={addUser}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-light"
          >
            Add
          </button>
        </div>
        {users.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {users.map((user) => (
              <span
                key={user.id}
                className={`inline-flex items-center gap-1 rounded-full ${user.color} px-3 py-1 text-xs font-medium text-white`}
              >
                {user.label}
                <button
                  onClick={() => removeUser(user.id)}
                  className="ml-1 hover:opacity-70"
                  aria-label={`Remove ${user.label}`}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Drag & Drop Area */}
      <DragDropContext onDragEnd={onDragEnd}>
        {/* Draggable User Tags Source */}
        {users.length > 0 && (
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
                        className={`inline-flex cursor-grab items-center rounded-full ${user.color} px-3 py-1.5 text-xs font-medium text-white shadow-sm ${
                          snapshot.isDragging ? "opacity-80 shadow-lg" : ""
                        }`}
                      >
                        {user.label}
                      </span>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        )}

        {/* Receipt Items */}
        <div className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Receipt Items
          </h2>
          {items.map((item) => {
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
                      <p className="font-semibold">
                        {formatCents(item.unit_price * item.quantity)}
                      </p>
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
      </DragDropContext>

      {/* Summary & Checkout Links */}
      {users.length > 0 && (
        <div className="mt-6 rounded-xl bg-surface p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
            Summary
          </h2>
          <div className="space-y-3">
            {users.map((user) => (
              <div
                key={user.id}
                className="flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-3 w-3 rounded-full ${user.color}`}
                  />
                  <span className="text-sm font-medium">{user.label}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold">
                    {formatCents(Math.round(userTotals[user.id] || 0))}
                  </span>
                  <button
                    onClick={() => copyLink(user)}
                    className="rounded-lg border border-border px-3 py-1 text-xs font-medium transition-colors hover:bg-surface-alt"
                  >
                    {linksCopied[user.id] ? "Copied!" : "Copy Link"}
                  </button>
                </div>
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
