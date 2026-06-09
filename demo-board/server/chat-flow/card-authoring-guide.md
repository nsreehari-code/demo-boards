## practical card-authoring guidance

A good card should do one job clearly. If a card is trying to be intake form, dashboard, workflow engine, narrative summary, and graph explorer all at once, it is badly shaped. A card should feel obvious in hindsight: “this is the card for X.” If that sentence is hard to say, split it.

Choose the view as part of the design, not as decoration. The soul doc is explicit that view kind is itself a design decision. Use the smallest expressive surface that matches the task:
- form when the user is supplying or editing structured input
- table when the user is scanning rows or comparing records
- chart when the point is trend, relationship, or distribution
- markdown/text when the point is interpretation or explanation
- badge/metric when the point is one number or one state
- action panel when the point is doing, not reading

A good card owns its boundary. It should know:
- what inputs it needs via `requires`
- what external work it performs via `source_defs`
- what deterministic shaping it does via `compute`
- what durable user-edited state belongs in `card_data`
- what outputs it contributes back via `provides`

That separation matters. Don’t bury fetched data in `card_data`. Don’t use `compute` for something that is really an external source. Don’t publish broad messy outputs if a smaller token would serve neighboring cards better.

Publish the smallest useful token. A card should provide outputs that other cards can consume cleanly, not dump its whole internal state onto the board. Good `provides` values are specific, named, and composable. If downstream cards only need “risk summary,” don’t make them depend on the whole upstream payload.

Make neighboring relationships intentional. Cards should form a meaningful local graph. A good card has clear upstream and downstream neighbors. It should be obvious why it sits next to another card: intake feeds truth, truth feeds analysis, analysis feeds action.

Keep source choice honest. The soul doc makes a strong point here: a “source” is not just a fetcher. It can be MCP, LLM, simulation, generated media, another agent. The principle is: use the right agent shape for the slot. If the slot needs deterministic retrieval, use a fetch/tool. If it needs judgment or synthesis, use an LLM-backed source. If it needs repeatable shaping, keep that in `compute`.

Design for live re-reading. These boards are live substrates, so a card should tolerate state changing between turns. Avoid designs that assume the world is static after first render. A good card can refresh, re-evaluate, and still make sense.

Prefer expressive cards over generic containers. A good card should feel like an intelligent unit, not a blank shell full of miscellaneous fields. Its title, description, renderer, layout, and outputs should all reinforce the same purpose.

Make the card useful in isolation. Since card chat is first-class, a user should be able to open one card and understand:
- what it is for
- what data it depends on
- what action they can take here
- what output they can trust from it

If a card only makes sense after reading five others, it may be too implicit.

Separate intake, truth, and action roles. Based on how this board is evolving, cards seem to fall into distinct semantic roles:
- ingest cards gather or normalize incoming evidence
- truthset cards represent structured knowledge or exploration over a truth source
- workspace/action cards interpret, simulate, summarize, decide, or trigger next steps

That separation is useful. Don’t make one card span all three roles unless there is a strong reason.

A good card should be editable without being fragile. User-editable pieces should be clearly in `card_data` or explicit form fields. Derived or fetched state should not be mixed into places the user is expected to hand-edit.

Use layout to communicate role, not just fill space. Position and pane membership are part of meaning. A card in Ingest should feel like intake. A card in Truthset Explore should feel like exploration over structured knowledge. A card on the main canvas should feel like part of the active working surface.

The simplest test is this: can you answer these in one sentence each?
- What is this card for?
- What does it depend on?
- What does it produce?
- Why is it here rather than as part of another card?

If those answers are crisp, the card is probably well-authored.

 