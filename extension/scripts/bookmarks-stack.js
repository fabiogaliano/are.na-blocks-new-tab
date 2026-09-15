// Two boards held as stacked cards: the inactive one sits behind at reduced scale with its
// header still visible, which is what you click to bring it forward.
export function createStack({ cards }) {
    const entries = cards.filter(Boolean);

    function bringToFront(card) {
        if (!entries.includes(card) || card.classList.contains("is-front")) {
            return;
        }
        for (const entry of entries) {
            const front = entry === card;
            entry.classList.toggle("is-front", front);
            entry.classList.toggle("is-back", !front);
            entry.setAttribute("aria-hidden", String(!front));
        }
    }

    for (const card of entries) {
        card.addEventListener("click", (event) => {
            if (card.classList.contains("is-back") && !event.target.closest("a")) {
                event.preventDefault();
                bringToFront(card);
            }
        });
    }

    if (entries.length) {
        bringToFront(entries[0]);
    }

    return {
        bringToFront,
        front: () => entries.find((card) => card.classList.contains("is-front")) || null
    };
}
