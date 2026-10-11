// Baseline: renders every product in one long grid.
// On purpose there is no search, no category filter, no price filter and no sort.
// That gap is what the A/B agent is supposed to discover and fix.
async function main() {
  const products = await (await fetch('/products.json')).json();
  render(products);
}

function render(products) {
  document.getElementById('count').textContent = `${products.length} products`;
  document.getElementById('grid').innerHTML = products
    .map(
      (p) => `
      <article class="card" data-category="${p.category}">
        <div class="emoji" aria-hidden="true">${p.emoji}</div>
        <h2>${p.name}</h2>
        <p class="meta">${p.category} · ${p.sizes.join(', ')}</p>
        <p class="price">$${p.price.toFixed(2)}</p>
        <button type="button">Add to cart</button>
      </article>`,
    )
    .join('');
}

main();
