"use client";

import { useState, useTransition } from "react";
import { addItem, searchSilpoProducts } from "@/app/parties/actions";
import { PendingButton } from "@/components/pending-button";
import type { SilpoProductOption } from "@/lib/silpo/cart";

function productLabel(product: SilpoProductOption) {
  const price = product.priceCents === undefined
    ? "ціна уточнюється"
    : `${(product.priceCents / 100).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} грн`;
  return [product.name, product.displayRatio, price].filter(Boolean).join(" · ");
}

export function SilpoProductPicker({ code }: { code: string }) {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<SilpoProductOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSearching, startSearch] = useTransition();
  const selected = products.find((product) => product.productId === selectedId);

  function search() {
    setError(null);
    startSearch(async () => {
      try {
        const results = await searchSilpoProducts(code, query);
        setProducts(results);
        setSelectedId("");
        if (!results.length) setError("«Сільпо» не знайшло доступних товарів за цим запитом.");
      } catch (searchError) {
        setProducts([]);
        setSelectedId("");
        setError(searchError instanceof Error ? searchError.message : "Не вдалося виконати пошук у «Сільпо». ");
      }
    });
  }

  return (
    <form action={addItem.bind(null, code)} className="add-item-form product-picker">
      <label>
        Пошук у «Сільпо»
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Наприклад, Молоко Галичина 3,2%"
          required
        />
      </label>
      <label>
        Кількість
        <input name="quantity" type="number" min="0.01" max="10000" step="0.01" defaultValue="1" required />
      </label>
      <button type="button" className="secondary-button" onClick={search} disabled={isSearching || query.trim().length < 2}>
        {isSearching ? "Шукаємо…" : "Пошук"}
      </button>

      {products.length > 0 && (
        <label className="product-picker-results">
          Оберіть товар
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} required>
            <option value="">Оберіть один з результатів</option>
            {products.map((product) => <option key={`${product.productId}:${product.companyId}:${product.branchId}`} value={product.productId}>{productLabel(product)}</option>)}
          </select>
        </label>
      )}
      <input type="hidden" name="name" value={selected?.name ?? ""} />
      <input type="hidden" name="silpo_product_id" value={selected?.productId ?? ""} />
      <input type="hidden" name="silpo_company_id" value={selected?.companyId ?? ""} />
      <input type="hidden" name="silpo_branch_id" value={selected?.branchId ?? ""} />
      {error && <p className="notice error product-picker-error" role="alert">{error}</p>}
      <PendingButton className="primary-button product-picker-add" disabled={!selected} pendingLabel="Додаємо…">
        Додати обраний товар
      </PendingButton>
    </form>
  );
}
