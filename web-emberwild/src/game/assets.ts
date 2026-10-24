import type { Npc } from "./world";

const A = "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets";

export const ART = {
  title: `${A}/img/94366765-b218-416a-85d3-57a4400c78c2.png`,
  icon: "/icon.png",
} as const;

// All 25 sprites are processed locally in public/monsters/v2 — transparent background,
// no baked outline, creature-internal black preserved. Rebuild with: bun scripts/sprites.ts
export const MONSTER_ART: Record<string, string> = Object.fromEntries(
  ["cindermaw", "mossback", "pipwisp", "slimekin", "boglurk", "nimbletuft", "thornhog", "dunescuttle", "frostnib", "gloamoth",
   "cragjaw", "hollowcrow", "regalslime", "sunwyrm", "bloomwisp", "zephyr_hawk", "tidefin_toad", "skullclub_orc", "crested_wyrm",
   "mandrake_maw", "jade_spikeon", "stormmane_drake", "crystal_golem", "skyhorn_dragon", "ironfang_tyrant",
  ].map((id) => [id, `/monsters/v2/${id}.png`]),
);

export const NEST_ART = {
  nest: "/monsters/v2/nest.png",
  nest_eggs: "/monsters/v2/nest_eggs.png",
} as const;

// Hamlet folk portraits, processed from the role art by: bun scripts/npcs.ts.
// Resident and recruiter use generated art directly (variant-aware portraits can replace these later).
export const NPC_ART: Record<Npc["role"], string> = {
  innkeep: "/npcs/innkeep.png",
  trader: "/npcs/trader.png",
  penkeeper: "/npcs/penkeeper.png",
  resident: "https://i3c71f2gn5ug0sxvn3ksc.rork.app/~assets/img/463d8dba-9074-45de-a9db-406ca893cee5.png",
  recruiter: "https://i3c71f2gn5ug0sxvn3ksc.rork.app/~assets/img/1983d1c2-1239-4aea-a5d8-b162032b2898.png",
  traveler: "https://i3c71f2gn5ug0sxvn3ksc.rork.app/~assets/img/463d8dba-9074-45de-a9db-406ca893cee5.png",
};

// The twelve rival tamers, one illustrated sprite each (hero/townsfolk art style),
// processed into public/tamers by scripts/tamer-art/rivals.ts. Keyed by tamer
// number: t1 → rival_1, t12 → rival_12.
export const RIVAL_ART: string[] = Array.from({ length: 12 }, (_, i) => `/tamers/rival_${i + 1}.png`);

export const MUSIC = {
  wilds: `${A}/aud/78b47f55-05a0-41cc-9936-686bc768b87f.mp3`,
  battle: `${A}/aud/d2d06a16-f11e-4d3c-90fd-9d80cbd1dcba.mp3`,
} as const;
