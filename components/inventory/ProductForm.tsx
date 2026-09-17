"use client";

import { useState } from "react";
import Image from "next/image";
import { Allergen, Rarity } from "@prisma/client";
import { PRODUCT_CATEGORIES } from "@/lib/validation";
import { rarityMeta } from "@/lib/rarity";
import { ShardButton } from "@/components/ui/ShardButton";
import { AllergenGate } from "./AllergenGate";
import { inventoryFetch } from "./inventoryApi";
import type { InventoryApiError, InventoryProduct } from "./types";

const RARITIES = Object.values(Rarity);

/** Dollars-and-cents text input -> integer cents (CLAUDE.md §2.1: money is
 * always an integer, never a float). Kept local to this component rather
 * than added to lib/money.ts, which is backend-owned. */
function parseDollarsToCents(raw: string): { cents: number } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "Enter a price." };
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) {
    return { error: "Enter a price like 1.75 — digits only, up to two decimal places, no $ sign." };
  }
  const cents = Math.round(Number(trimmed) * 100);
  if (cents < 1) return { error: "Price must be at least $0.01. Free products aren't supported — there's no comp path." };
  if (cents > 5000) return { error: "Price must be $50.00 or less. If this is really over $50, flag it before saving." };
  return { cents };
}

function centsToDollarInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Mirrors docs/API-CONTRACT.md §6b's "Photo handling" table. This is a
 * client-side pre-check for a clearer message than a raw 400 — the server
 * validation is still the real gate. */
function validateImageUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return "Enter a photo location.";
  if (url.length > 512) return "That's too long (512 characters max).";
  if (/^(data|javascript|blob|file):/i.test(url)) return "That's not a photo location.";
  if (url.startsWith("//")) {
    return 'Protocol-relative paths (starting "//") read as a remote site, not a photo — use a full https:// URL or a path starting with a single "/".';
  }
  if (url.startsWith("http://")) {
    return "http:// (not https) silently fails to load on this site — use https:// or a site-relative path starting with /.";
  }
  if (url.startsWith("/") || url.startsWith("https://")) return null;
  return 'Enter a site-relative path (e.g. "/products/foo.svg") or a full "https://" URL.';
}

function parseOptionalInt(raw: string, min: number, max: number, label: string): { value?: number } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: undefined };
  if (!/^\d+$/.test(trimmed)) return { error: `${label} must be a whole number.` };
  const n = Number(trimmed);
  if (n < min || n > max) return { error: `${label} must be between ${min} and ${max}.` };
  return { value: n };
}

type CommonProps = {
  onSaved: (product: InventoryProduct) => void;
  onCancel: () => void;
  onUnauthorized: () => void;
};

type Props = CommonProps & ({ mode: "create" } | { mode: "edit"; initial: InventoryProduct });

export function ProductForm(props: Props) {
  const { onSaved, onCancel, onUnauthorized } = props;
  const isEdit = props.mode === "edit";
  const initial: InventoryProduct | null = props.mode === "edit" ? props.initial : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(""); // create-only; blank = server derives from name
  const [description, setDescription] = useState(initial?.description ?? "");
  const [priceInput, setPriceInput] = useState(initial ? centsToDollarInput(initial.priceCents) : "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [rarity, setRarity] = useState<Rarity | "">(initial?.rarity ?? "");
  const [imageUrl, setImageUrl] = useState(initial?.imageUrl ?? "");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [sortOrderInput, setSortOrderInput] = useState(
    initial && initial.sortOrder !== 0 ? String(initial.sortOrder) : "",
  );
  const [stockQtyInput, setStockQtyInput] = useState(""); // create-only, absolute, never defaulted
  const [active, setActive] = useState(initial?.active ?? false);

  const [allergens, setAllergens] = useState<Allergen[]>(initial?.allergens ?? []);
  const [allergensReviewed, setAllergensReviewed] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<InventoryApiError | null>(null);
  const [blockMessage, setBlockMessage] = useState<string | null>(null);

  const initialAllergensKey = initial ? [...initial.allergens].sort().join(",") : "";
  const currentAllergensKey = [...allergens].sort().join(",");
  const allergensChanged = isEdit && currentAllergensKey !== initialAllergensKey;
  const activeChanged = isEdit && active !== initial!.active;
  const publishing = active === true && (!isEdit || activeChanged);

  function handleAllergensChange(next: Allergen[]) {
    setAllergens(next);
    // Any edit to the checklist un-affirms it — a stale "reviewed" flag from
    // earlier in the same sitting must never carry a later edit across the
    // gate. See AllergenGate.tsx and docs/API-CONTRACT.md §6b.
    setAllergensReviewed(false);
  }

  function handleActiveChange(next: boolean) {
    setActive(next);
    if (next) {
      // Publishing always re-requires the affirmation, even if the editor
      // didn't touch a single checkbox this session (§6b: "any attempt to
      // set active: true requires allergensReviewed: true").
      setAllergensReviewed(false);
    }
  }

  async function handleImageUpload(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBlockMessage(null);
    setUploadingImage(true);

    const body = new FormData();
    body.append("file", file);
    const res = await inventoryFetch<{ imageUrl: string }>("/api/inventory/images", {
      method: "POST",
      body,
      headers: {},
    });

    setUploadingImage(false);
    if (!res.ok) {
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      setError(res.error);
      return;
    }

    setImageUrl(res.data.imageUrl);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setBlockMessage(null);

    if (name.trim().length < 2 || name.trim().length > 80) {
      setBlockMessage("Name must be 2–80 characters.");
      return;
    }
    if (description.trim().length < 1 || description.trim().length > 400) {
      setBlockMessage("Description must be 1–400 characters.");
      return;
    }
    const price = parseDollarsToCents(priceInput);
    if ("error" in price) {
      setBlockMessage(price.error);
      return;
    }
    if (!category) {
      setBlockMessage("Choose a category.");
      return;
    }
    if (!rarity) {
      setBlockMessage("Choose a rarity.");
      return;
    }
    const imageError = validateImageUrl(imageUrl);
    if (imageError) {
      setBlockMessage(imageError);
      return;
    }
    const sortOrder = parseOptionalInt(sortOrderInput, 0, 9999, "Sort order");
    if ("error" in sortOrder) {
      setBlockMessage(sortOrder.error);
      return;
    }

    // --- The allergen/publish gate. Client-side mirror of
    // docs/API-CONTRACT.md §6b's three rules, so the block reads as a
    // deliberate safety stop rather than a server 400. ---
    if (!isEdit) {
      // Create always requires the affirmation, unconditionally.
      if (!allergensReviewed) {
        setBlockMessage(
          "Check the allergen confirmation below before creating this product — required for every new product, even an inactive draft.",
        );
        return;
      }
    } else {
      if (publishing && !allergensReviewed) {
        setBlockMessage(
          "Publishing this product (making it visible to shoppers) requires reviewing the allergen list and checking the confirmation below.",
        );
        return;
      }
      if (allergensChanged && !allergensReviewed) {
        setBlockMessage(
          "You changed the allergen list — check the confirmation below to save that change, or restore the original boxes and leave it unchecked.",
        );
        return;
      }
    }

    let stockQty: number | undefined;
    if (!isEdit) {
      const parsed = parseOptionalInt(stockQtyInput, 0, 10000, "Stock quantity");
      if ("error" in parsed) {
        setBlockMessage(parsed.error);
        return;
      }
      if (parsed.value === undefined) {
        setBlockMessage("Enter a starting stock quantity (0 is fine if none are on the shelf yet).");
        return;
      }
      stockQty = parsed.value;
    }

    setSubmitting(true);

    const includeAllergens = !isEdit || allergensReviewed;

    const body: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim(),
      priceCents: price.cents,
      category,
      rarity,
      imageUrl: imageUrl.trim(),
      ...(sortOrder.value !== undefined ? { sortOrder: sortOrder.value } : {}),
      ...(includeAllergens ? { allergens, allergensReviewed: true } : {}),
    };

    if (!isEdit) {
      body.active = active;
      body.stockQty = stockQty;
      if (slug.trim() !== "") body.slug = slug.trim();
    } else if (activeChanged) {
      body.active = active;
    }

    const res = isEdit
      ? await inventoryFetch<{ product: InventoryProduct }>(
          `/api/inventory/products/${initial!.id}`,
          { method: "PATCH", body: JSON.stringify(body) },
        )
      : await inventoryFetch<{ product: InventoryProduct }>("/api/inventory/products", {
          method: "POST",
          body: JSON.stringify(body),
        });

    setSubmitting(false);

    if (!res.ok) {
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      setError(res.error);
      return;
    }

    onSaved(res.data.product);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="border-2 border-danger bg-surface-2 p-3 text-sm text-danger">
          {formatServerError(error)}
        </p>
      )}
      {blockMessage && (
        <p role="alert" className="border-2 border-gold bg-surface-2 p-3 text-sm text-gold">
          {blockMessage}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="pf-name">
          <input
            id="pf-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            className={inputClass}
          />
        </Field>

        {!isEdit ? (
          <Field
            label="Slug (optional)"
            htmlFor="pf-slug"
            hint="Leave blank to auto-generate from the name. Can't be changed after this."
          >
            <input
              id="pf-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="auto-generated from name"
              className={inputClass}
            />
          </Field>
        ) : (
          <Field label="Slug" htmlFor="pf-slug-locked" hint="Locked. Slugs can't change after creation.">
            <input id="pf-slug-locked" value={initial!.slug} disabled className={`${inputClass} opacity-60`} />
          </Field>
        )}
      </div>

      <Field label="Description" htmlFor="pf-description">
        <textarea
          id="pf-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={400}
          rows={3}
          required
          className={inputClass}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Price (dollars)" htmlFor="pf-price" hint="e.g. 1.75 for $1.75. $0.01–$50.00.">
          <input
            id="pf-price"
            inputMode="decimal"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            placeholder="1.75"
            required
            className={inputClass}
          />
        </Field>

        <Field label="Category" htmlFor="pf-category">
          <select
            id="pf-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
            className={inputClass}
          >
            <option value="" disabled>
              Select a category
            </option>
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Rarity" htmlFor="pf-rarity">
          <select
            id="pf-rarity"
            value={rarity}
            onChange={(e) => setRarity(e.target.value as Rarity)}
            required
            className={inputClass}
          >
            <option value="" disabled>
              Select a rarity
            </option>
            {RARITIES.map((r) => (
              <option key={r} value={r}>
                {rarityMeta(r).label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Product photo"
          htmlFor="pf-image"
          hint="Choose a JPG, PNG, WEBP, or GIF up to 5 MB, or enter an https:// URL."
        >
          <input
            id="pf-image-upload"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={(e) => void handleImageUpload(e.target.files?.[0])}
            disabled={uploadingImage || submitting}
            className="mb-2 block w-full text-sm text-text-dim file:mr-3 file:border-2 file:border-brand file:bg-brand/10 file:px-3 file:py-2 file:font-mono file:text-xs file:uppercase file:text-brand"
          />
          <input
            id="pf-image"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="/products/example.svg"
            required
            className={inputClass}
          />
          {uploadingImage && <p className="mt-1 text-xs text-text-dim">Uploading image…</p>}
          {imageUrl && (
            <Image
              src={imageUrl}
              alt=""
              width={96}
              height={96}
              className="mt-3 h-24 w-24 border-2 border-white/10 object-cover"
            />
          )}
        </Field>

        <Field label="Sort order (optional)" htmlFor="pf-sort" hint="0–9999. Leave blank for default.">
          <input
            id="pf-sort"
            inputMode="numeric"
            value={sortOrderInput}
            onChange={(e) => setSortOrderInput(e.target.value)}
            placeholder="0"
            className={inputClass}
          />
        </Field>
      </div>

      {!isEdit && (
        <Field
          label="Starting stock quantity"
          htmlFor="pf-stock"
          hint="Absolute count, only set here at creation. 0–10000. After this, stock only changes by a +/- adjustment."
        >
          <input
            id="pf-stock"
            inputMode="numeric"
            value={stockQtyInput}
            onChange={(e) => setStockQtyInput(e.target.value)}
            placeholder="0"
            required
            className={inputClass}
          />
        </Field>
      )}

      <AllergenGate
        idPrefix={isEdit ? initial!.id : "create"}
        value={allergens}
        onChange={handleAllergensChange}
        reviewed={allergensReviewed}
        onReviewedChange={setAllergensReviewed}
      />

      <label className="flex items-center gap-3 border-2 border-white/10 bg-surface-2 p-4 text-sm text-text">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => handleActiveChange(e.target.checked)}
          className="h-5 w-5"
        />
        <span>
          <strong>Publish — visible to shoppers.</strong>{" "}
          <span className="text-text-dim">
            Leave unchecked to save as a draft that nobody can order yet.
            Checking this (or re-saving it while already checked) requires
            the allergen confirmation above.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap gap-3">
        <ShardButton type="submit" loading={submitting}>
          {isEdit ? "Save changes" : "Create product"}
        </ShardButton>
        <ShardButton type="button" intent="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </ShardButton>
      </div>
    </form>
  );
}

function formatServerError(error: InventoryApiError): string {
  switch (error.code) {
    case "ALLERGENS_NOT_REVIEWED":
      return "The server rejected this because the allergen confirmation wasn't included. Check the box in the allergen section and try again.";
    case "PRODUCT_SLUG_TAKEN":
      return `That slug ("${String(error.slug ?? "")}") is already used by another product. Change the name (or the slug) so it's unique.`;
    case "PRODUCT_UNAVAILABLE":
      return "That product no longer exists — it may have been removed by another editor. Reload the list.";
    case "INVENTORY_NOT_CONFIGURED":
      return "Catalog editing isn't configured on this server right now. That's an ops problem — tell whoever manages the deployment.";
    case "RATE_LIMITED":
      return "Too many attempts. Wait a minute, then try again.";
    default:
      return error.message;
  }
}

const inputClass =
  "border-2 border-white/10 bg-surface-2 px-3 py-2 text-text focus:border-brand disabled:opacity-60";

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="font-mono text-xs uppercase text-text-faint">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-text-dim">{hint}</p>}
    </div>
  );
}
