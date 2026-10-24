import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Backpack, BookOpen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Compass, Drumstick, Egg, Flame, Hourglass, LogOut, Navigation, PawPrint,
  ScrollText, Search, Sparkles, Sprout, Target, Tent, Volume2, VolumeX, X,
} from "lucide-react";
import { engage, engagedNear, partyMonAt, queueSkill, queueSkillTile, setOrder, setTarget } from "@/game/combat";
import { skillOf } from "@/game/signature";
import { SKILLS, SPECIES } from "@/game/data";
import { hatchCarriedEgg, postponeHatch } from "@/game/eggs";
import { getFactions, learnNotices } from "@/game/factions";
import { bodyFootprint } from "@/game/growth";
import { tileVisibility } from "@/game/knowledge";
import { layerOf, walkable } from "@/game/height";
import { displayName, statOf } from "@/game/monster";
import { warmOverviewAsync, warmRegionAround, zoomIn, zoomOut, type MapScale } from "@/game/mapview";
import { warmRoadsAsync } from "@/game/roads";
import { isSettlement } from "@/game/settlement";
import { addLog, contextActions, creatureAt, movePlayer, runContextAction, searchRuin, waitTurn, type ActionResult } from "@/game/sim";

import { act, playMusic, saveNow, setScreen, toggleMute, useGame } from "@/game/store";
import type { GameState, LogKind } from "@/game/types";
import { SEASONS, findPath, getWorld, seasonIndex, timeOf, type Npc } from "@/game/world";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { User } from "lucide-react";
import { BestiarySheet } from "./Bestiary";
import { CreatureCard, MemoryTileCard, NpcCard, PartyCommandCard, TileCard, UnknownTileCard, WEATHER_ICON, WEATHER_NAME, useSelectedCreature, type PickMode } from "./Inspector";
import { MapLegend, ScaleTitle, ZoomControls } from "./MapHud";
import { BagSheet, CampSheet, NpcSheet, NoticesSheet, OfferSheet, PartySheet, ShrineSheet, StandingSheet } from "./Sheets";
import { WorldMap } from "./WorldMap";
import { Bar, Portrait, hpColor } from "./ui";

const LOG_COLOR: Record<LogKind, string> = {
  info: "text-parchment/80", event: "text-[#9fd3e6]", combat: "text-[#ffb347]", system: "text-gold", good: "text-[#7be08a]", bad: "text-[#ff8a7a]", weather: "text-[#c9b7e6]",
};

const CTX_ICON = { egg: Egg, dress: Drumstick, forage: Sprout } as const;

type SheetId = "party" | "bag" | "bestiary" | "camp" | "shrine" | "offer" | "notices" | "standing" | null;

export function GameScreen() {
  const { gs, v, muted } = useGame();
  const state = gs as GameState;
  const [sel, setSel] = useState<{ x: number; y: number } | null>(null);
  const [pick, setPick] = useState<PickMode | null>(null);
  const [sheet, setSheet] = useState<SheetId>(null);
  const [offerId, setOfferId] = useState<string | null>(null);
  const [npcTalk, setNpcTalk] = useState<Npc | null>(null);
  const [path, setPath] = useState<[number, number][] | null>(null);
  const [logOpen, setLogOpen] = useState<boolean>(false);
  const [ctxOpen, setCtxOpen] = useState<boolean>(false);
  const [scale, setScale] = useState<MapScale>("local");
  const travelRef = useRef<number | null>(null);
  const world = getWorld(state.seed);
  // ready stolen eggs light the Hatch button; the freshest one raises the keep-or-release prompt
  const readyEggs = (state.eggs ?? []).filter((e) => state.tick >= e.hatchTick);
  const hatchEgg = readyEggs.find((e) => !e.prompted) ?? null;

  const stopTravel = useCallback((): void => {
    if (travelRef.current !== null) window.clearInterval(travelRef.current);
    travelRef.current = null;
    setPath(null);
  }, []);

  const handleResult = useCallback((r: ActionResult | undefined): boolean => {
    if (r?.engaged) {
      stopTravel();
      const c = state.creatures[r.engaged];
      if (c) setSel({ x: c.x, y: c.y });
      return true;
    }
    if (r?.bumped) {
      const c = state.creatures[r.bumped];
      if (c) setSel({ x: c.x, y: c.y });
    }
    return false;
  }, [state, stopTravel]);

  const step = useCallback((dx: number, dy: number): void => {
    stopTravel();
    const r = act((g) => movePlayer(g, dx, dy));
    handleResult(r);
  }, [handleResult, stopTravel]);

  const travelTo = useCallback((tx: number, ty: number): void => {
    stopTravel();
    const p = findPath(world, state.player.x, state.player.y, tx, ty, 6000, layerOf(state));
    if (!p || !p.length) {
      act((g) => { g.logSeq += 1; g.log.push({ id: g.logSeq, tick: g.tick, text: "You can't find a way there.", kind: "info" }); });
      return;
    }
    const queue = [...p];
    setPath(queue);
    const startStalkers = Object.values(state.creatures).filter((c) => c.stalking).length;
    travelRef.current = window.setInterval(() => {
      const next = queue.shift();
      if (!next) return stopTravel();
      const g = state;
      const dx = next[0] - g.player.x;
      const dy = next[1] - g.player.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return stopTravel();
      const r = act((gg) => movePlayer(gg, dx, dy));
      if (handleResult(r) || !r?.ok) return stopTravel();
      setPath([...queue]);
      const stalkers = Object.values(g.creatures).filter((c) => c.stalking).length;
      if (stalkers > startStalkers || (layerOf(g) >= 0 && world.tile(g.player.x, g.player.y).feature)) stopTravel();
    }, 120);
  }, [handleResult, state, stopTravel, world]);

  useEffect(() => () => stopTravel(), [stopTravel]);

  // diegetic battle music: crossfade while hostiles are engaged nearby
  const inCombat = engagedNear(state);
  useEffect(() => {
    playMusic(inCombat ? "battle" : "wilds");
  }, [inCombat]);

  // Warm map aggregation caches in the background so zooming never hitches,
  // and survey the national road network in time slices — roads appear on
  // the map as they are finished, and the final layout is identical to a
  // one-shot build.
  useEffect(() => {
    const w = getWorld(state.seed);
    warmRegionAround(w, state.player.x, state.player.y, 120);
    const stop = warmOverviewAsync(state.seed, w);
    const warm = warmRoadsAsync(w);
    return () => {
      stop();
      warm();
    };
  }, [state.seed]);

  const tryTravel = useCallback((tx: number, ty: number): void => {
    if (tileVisibility(state, tx, ty) === "fog") {
      act((g) => addLog(g, "You can't travel into lands you've never seen.", "info"));
      return;
    }
    if (!walkable(world, layerOf(state), tx, ty)) {
      act((g) => addLog(g, "You can't travel there.", "info"));
      return;
    }
    travelTo(tx, ty);
  }, [state, travelTo, world]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (sheet || hatchEgg) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const map: Record<string, [number, number]> = {
        ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
        w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], k: [0, -1], j: [0, 1], h: [-1, 0], l: [1, 0],
        y: [-1, -1], u: [1, -1], b: [-1, 1], n: [1, 1], q: [-1, -1], e: [1, -1], z: [-1, 1], c: [1, 1],
      };
      const m = map[e.key];
      if (m) {
        e.preventDefault();
        step(m[0], m[1]);
      } else if (e.key === "." || e.key === " ") {
        e.preventDefault();
        handleResult(act((g) => waitTurn(g, 1)));
      } else if (e.key === "g" || e.key === "f" || e.key === "e") handleResult(act((g) => runContextAction(g, contextActions(g)[0]?.id ?? "forage")));
      else if (e.key === "p") setSheet("party");
      else if (e.key === "i") setSheet("bag");
      else if (e.key === "m") setScale((s) => (s === "local" ? "region" : s === "region" ? "world" : "local"));
      else if (e.key === "+" || e.key === "=") setScale((s) => zoomIn(s));
      else if (e.key === "-") setScale((s) => zoomOut(s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, hatchEgg, state, step, handleResult]);

  const atSettlement = layerOf(state) >= 0 && isSettlement(world.siteAt(state.player.x, state.player.y));

  const onTap = useCallback((x: number, y: number): void => {
    const px = state.player.x;
    const py = state.player.y;
    if (scale !== "local") {
      if (sel && sel.x === x && sel.y === y) {
        if (scale === "region") tryTravel(x, y);
        return;
      }
      setSel({ x, y });
      return;
    }
    // pick mode: taps choose a target — never inspect, never travel
    if (pick) {
      const pickMon = state.party.find((mm) => mm.uid === pick.uid);
      const sk = pick.mode === "skill" ? skillOf(pickMon, pick.skillId) : null;
      const cr = creatureAt(state, x, y);
      if (cr) {
        if (pick.mode === "target") {
          act((g) => {
            setTarget(g, cr.id);
            setOrder(g, pick.uid, "attack");
          });
          setPick(null);
          return;
        }
        if (pick.mode === "skill" && sk && (sk.target === "enemy" || sk.target === "tile")) {
          act((g) => queueSkill(g, pick.uid, pick.skillId, cr.id));
          setPick(null);
          return;
        }
        return; // this skill can't take a wild target
      }
      const pm = partyMonAt(state, x, y);
      if (pick.mode === "skill" && sk && pm && (sk.target === "ally" || sk.target === "tile")) {
        act((g) => queueSkill(g, pick.uid, pick.skillId, pm.uid));
        setPick(null);
        return;
      }
      // empty ground: any castable move can be aimed at the tile itself
      if (pick.mode === "skill" && sk && (sk.target === "enemy" || sk.target === "tile" || sk.target === "ally")) {
        act((g) => queueSkillTile(g, pick.uid, pick.skillId, x, y));
        setPick(null);
        return;
      }
      return; // keep waiting for a valid pick
    }
    const npc = world.npcAt(x, y, state.tick);
    if (npc) {
      if (Math.abs(x - px) <= 1 && Math.abs(y - py) <= 1) {
        setSel(null);
        setNpcTalk(npc);
      } else {
        setSel({ x, y });
      }
      return;
    }
    if (x === px && y === py) {
      setSel({ x, y });
      return;
    }
    // your own monsters: command console
    if (partyMonAt(state, x, y)) {
      setSel({ x, y });
      return;
    }
    // enemies: first tap marks the target and opens the inspect card
    const cr = creatureAt(state, x, y);
    if (cr) {
      const hostile = cr.stalking || (cr.disposition === "aggressive" && cr.calmUntil <= state.tick);
      if (hostile && state.party.some((m) => m.hp > 0)) act((g) => setTarget(g, cr.id));
      setSel({ x: cr.x, y: cr.y });
      return;
    }
    const adj = Math.abs(x - px) <= 1 && Math.abs(y - py) <= 1;
    if (sel && sel.x === x && sel.y === y) {
      if (adj) step(x - px, y - py);
      else tryTravel(x, y);
      return;
    }
    setSel({ x, y });
  }, [pick, sel, scale, state, step, tryTravel, world]);

  const time = timeOf(state.tick);
  const weather = world.weather(state.player.x, state.player.y, state.tick);
  const WIcon = WEATHER_ICON[weather.id];
  const here = world.tile(state.player.x, state.player.y);
  const inCaves = layerOf(state) < 0;
  // landmarks live on the surface: underground, the tile above you is not "here"
  const feature = inCaves ? null : here.feature;
  const fac = getFactions(state.seed);
  const noticesHere = useMemo(() => (feature && isSettlement(feature) ? fac.settlementNotices(feature) : []), [feature, fac]);
  const selCreature = useSelectedCreature(state, sel);
  const selMon = sel ? partyMonAt(state, sel.x, sel.y) : null;
  const selNpc = sel ? world.npcAt(sel.x, sel.y, state.tick) : null;
  // reach ring while picking: skill range (or melee) around the ordering monster's body
  const reach = useMemo(() => {
    if (!pick || scale !== "local") return null;
    const pos = state.field[pick.uid];
    const m = state.party.find((mm) => mm.uid === pick.uid);
    if (!pos || !m) return null;
    const r = (pick.mode === "target" ? 1 : skillOf(m, pick.skillId)?.range ?? 1) + bodyFootprint(m, state.tick) - 1;
    return { x: pos.x, y: pos.y, r };
  }, [pick, scale, state, v]);
  const inspectAt = sel ?? { x: state.player.x, y: state.player.y };
  const inspectVis = tileVisibility(state, inspectAt.x, inspectAt.y);
  const ctx = contextActions(state);
  const ctxTop = ctx[0];
  const recentLog = useMemo(() => state.log.slice(-60), [state.log, v]);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state.logSeq, logOpen]);

  const openOffer = (id: string): void => {
    setOfferId(id);
    setSheet("offer");
  };
  const fight = (id: string): void => {
    const c = state.creatures[id];
    if (!c || !state.party.some((m) => m.hp > 0)) return;
    stopTravel();
    act((g) => engage(g, id, false));
    setSel({ x: c.x, y: c.y });
  };
  const decideEgg = (eggId: string, choice: "keep" | "release"): void => {
    const msg = act((g) => hatchCarriedEgg(g, eggId, choice));
    if (msg) toast(msg);
  };

  const inspector = (
    <div className="space-y-3">
      {selMon ? (
        <PartyCommandCard
          gs={state}
          mon={selMon}
          picking={pick && pick.uid === selMon.uid ? pick : null}
          onPickTarget={(uid) => setPick({ mode: "target", uid })}
          onOrderSkill={(uid, s) => {
            if (skillOf(selMon, s)?.target === "self") {
              act((g) => queueSkill(g, uid, s, uid));
              setPick(null);
            } else {
              setPick({ mode: "skill", uid, skillId: s });
            }
          }}
        />
      ) : null}
      {selCreature ? (
        <CreatureCard
          gs={state}
          c={selCreature}
          onFight={() => fight(selCreature.id)}
          onFeed={() => openOffer(selCreature.id)}
          onApproach={() => travelTo(selCreature.x, selCreature.y)}
          onTarget={() => act((g) => setTarget(g, selCreature.id))}
        />
      ) : null}
      {selNpc && inspectVis !== "fog" ? (
        <NpcCard npc={selNpc} gs={state} onTalk={() => setNpcTalk(selNpc)} onApproach={() => tryTravel(selNpc.x, selNpc.y)} />
      ) : null}
      {inspectVis === "visible" ? <TileCard gs={state} x={inspectAt.x} y={inspectAt.y} /> : inspectVis === "memory" ? <MemoryTileCard gs={state} x={inspectAt.x} y={inspectAt.y} /> : <UnknownTileCard gs={state} x={inspectAt.x} y={inspectAt.y} />}
      {sel && !(sel.x === state.player.x && sel.y === state.player.y) && !selCreature && inspectVis !== "fog" && walkable(world, layerOf(state), sel.x, sel.y) ? (
        <button className="btn-game btn-night h-11 w-full text-sm" onClick={() => tryTravel(sel.x, sel.y)}>
          <Compass className="h-4 w-4" /> Travel here
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-night">
      {/* Top bar */}
      <header className="z-20 flex items-center gap-2 border-b-2 border-frame/70 bg-night-2 px-2 py-1.5 sm:px-3 safe-top">
        <button onClick={() => { saveNow(); playMusic(null); setScreen("title"); }} className="wordmark hidden px-1 text-2xl sm:block" aria-label="Back to title">EMBERWILD</button>
        <Flame className="h-6 w-6 text-ember sm:hidden" fill="#f2c14e" />
        <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto sm:ml-3 sm:gap-1">
          <TopTab icon={PawPrint} label="Monsters" onClick={() => setSheet("party")} />
          <TopTab icon={Backpack} label="Bag" onClick={() => setSheet("bag")} />
          <TopTab icon={BookOpen} label="Bestiary" onClick={() => setSheet("bestiary")} />
          <TopTab icon={Tent} label="Camp" onClick={() => setSheet("camp")} />
          <TopTab icon={User} label="Standing" onClick={() => setSheet("standing")} />
        </nav>
        <div className="flex items-center gap-2 pl-1">
          <WIcon className={cn("h-6 w-6", weather.id === "clear" ? "text-gold" : "text-parchment/80")} />
          <div className="text-right leading-tight">
            <div className="font-pixel text-[14px] text-parchment">Day {time.day}</div>
            <div className="font-mono text-[10.5px] text-parchment/60">{time.phase} · {time.label}</div>
          </div>
          <button onClick={toggleMute} className="hidden h-10 w-10 place-items-center rounded-md text-parchment/70 hover:bg-white/5 sm:grid" aria-label="Toggle music">
            {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
          <button onClick={() => { saveNow(); playMusic(null); setScreen("title"); }} className="grid h-10 w-10 place-items-center rounded-md text-parchment/70 hover:bg-white/5" aria-label="Save and quit">
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <WorldMap gs={state} v={v} scale={scale} selected={sel} path={scale === "world" ? null : path} reach={reach} onTap={onTap} />
            <ZoomControls scale={scale} onZoom={(d) => setScale((s) => (d === 1 ? zoomIn(s) : zoomOut(s)))} onCenter={() => setScale("local")} />
            {scale !== "local" ? <MapLegend scale={scale} /> : null}
            <ScaleTitle scale={scale} region={world.regionName(state.player.x, state.player.y)} />

            {/* targeting banner */}
            {pick ? (
              <div className="absolute left-1/2 top-2 z-30 flex max-w-[92%] -translate-x-1/2 animate-in fade-in items-center gap-2 rounded-md border-2 border-ember/70 bg-night/90 py-1.5 pl-3 pr-1.5 font-pixel text-[12px] text-gold shadow-lg backdrop-blur-sm duration-150">
                <Target className="h-4 w-4 shrink-0 text-ember" />
                <span className="truncate">
                  {pick.mode === "target"
                    ? `Tap an enemy — ${displayName(state.party.find((m) => m.uid === pick.uid) ?? state.party[0])} will hunt it`
                    : (() => {
                        const sk = skillOf(state.party.find((m) => m.uid === pick.uid), pick.skillId);
                        return `Tap a target for ${sk?.name ?? pick.skillId} · reach ${sk?.range ?? 1}`;
                      })()}
                </span>
                <button onClick={() => setPick(null)} className="grid h-8 w-8 shrink-0 place-items-center rounded text-parchment/70 hover:bg-white/10" aria-label="Cancel targeting">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : null}

            {/* Party strip */}
            <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1.5">
              {state.party.map((m) => {
                const max = statOf(m, "hp");
                return (
                  <button key={m.uid} onClick={() => setSheet("party")} className="pointer-events-auto flex items-center gap-1.5 rounded-md border-2 border-frame/80 bg-night/85 p-1 pr-2 backdrop-blur-sm">
                    <Portrait speciesId={m.speciesId} size={34} />
                    <div className="w-[78px] text-left">
                      <div className="flex justify-between font-pixel text-[11px] leading-none text-parchment">
                        <span className="truncate">{displayName(m)}</span>
                        <span className="text-parchment/50">{m.level}</span>
                      </div>
                      <Bar value={m.hp} max={max} color={hpColor(m.hp / max)} className="mt-1 h-1.5" />
                      <Bar value={m.satiety} max={100} color="linear-gradient(180deg,#f2c14e,#c98a2b)" className="mt-0.5 h-1" />
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Compass / coordinates */}
            <div className="pointer-events-none absolute bottom-2 left-2 rounded-md border-2 border-frame/80 bg-night/85 px-2 py-1 font-mono text-[11px] text-parchment/80 backdrop-blur-sm">
              <div className="flex items-center gap-1 font-pixel text-[12px] text-gold">
                {state.player.fx !== state.player.x || state.player.fy !== state.player.y ? (
                  <Navigation
                    className="h-3 w-3"
                    style={{ transform: `rotate(${(Math.atan2(state.player.y - state.player.fy, state.player.x - state.player.fx) * 180) / Math.PI + 90}deg)` }}
                  />
                ) : null}
                {world.regionName(state.player.x, state.player.y)}
              </div>
              {state.player.x}, {state.player.y} · {SEASONS[seasonIndex(state.tick)]} · {weather.temp}°C · {WEATHER_NAME[weather.id]}
              <div className="text-parchment/60">{state.player.gold}g</div>
            </div>

            {scale === "local" ? <DPad onStep={step} onWait={() => handleResult(act((g) => waitTurn(g, 1)))} /> : null}

            {/* context pick-list: several actions at once */}
            {ctxOpen && ctx.length > 1 ? (
              <>
                <button className="fixed inset-0 z-20 cursor-default" onClick={() => setCtxOpen(false)} aria-label="Close actions" />
                <div className="absolute bottom-2 left-1/2 z-30 w-44 -translate-x-1/2 animate-in fade-in slide-in-from-bottom-2 rounded-md border-2 border-frame bg-night-2 p-1 shadow-[0_8px_24px_rgba(0,0,0,.5)] duration-150">
                  {ctx.map((a) => {
                    const CIcon = CTX_ICON[a.id];
                    return (
                      <button
                        key={a.id}
                        onClick={() => { setCtxOpen(false); handleResult(act((g) => runContextAction(g, a.id))); }}
                        className="flex h-11 w-full items-center gap-2 rounded px-2.5 text-left font-pixel text-[13px] text-parchment hover:bg-white/5 active:bg-ember/20"
                      >
                        <CIcon className="h-4 w-4 text-gold" /> {a.label}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}

            {path ? (
              <button onClick={stopTravel} className="btn-game btn-night absolute right-2 top-52 h-10 text-sm">
                <X className="h-4 w-4" /> Stop
              </button>
            ) : null}
          </div>

          {/* Action bar */}
          <div className="z-10 flex gap-1.5 overflow-x-auto border-t-2 border-frame/70 bg-night-2 px-2 py-1.5">
            {feature?.kind === "shrine" ? <ActBtn icon={Sparkles} label="Shrine" primary onClick={() => setSheet("shrine")} /> : null}
            {feature?.kind === "ruin" ? <ActBtn icon={Search} label="Search Ruins" primary onClick={() => handleResult(act((g) => searchRuin(g)))} /> : null}
            {isSettlement(feature) && noticesHere.length ? (
              <ActBtn icon={ScrollText} label="Notices" primary onClick={() => { act((g) => learnNotices(g, feature)); setSheet("notices"); }} />
            ) : null}
            <ActBtn
              icon={CTX_ICON[ctxTop?.id ?? "forage"]}
              label={ctxTop?.label ?? "Forage"}
              disabled={!ctxTop}
              badge={ctx.length > 1 ? `+${ctx.length - 1}` : undefined}
              onClick={() => {
                if (!ctxTop) return;
                if (ctx.length > 1) setCtxOpen(true);
                else handleResult(act((g) => runContextAction(g, ctxTop.id)));
              }}
            />
            {readyEggs.length ? (
              <ActBtn
                icon={Egg}
                label="Hatch"
                primary
                badge={readyEggs.length > 1 ? `${readyEggs.length}` : undefined}
                onClick={() => setSheet("bag")}
              />
            ) : null}
            <ActBtn icon={Hourglass} label="Wait 1h" onClick={() => handleResult(act((g) => waitTurn(g, 12)))} />
            <ActBtn icon={Tent} label="Camp" onClick={() => setSheet("camp")} />
            <ActBtn icon={Compass} label="Inspect" className="lg:hidden" onClick={() => setSel(sel ?? { x: state.player.x, y: state.player.y })} />
          </div>

          {/* Log */}
          <div className="z-10 border-t-2 border-frame/70 bg-night">
            <button onClick={() => setLogOpen((o) => !o)} className="flex h-7 w-full items-center justify-between px-3 font-pixel text-[12px] text-gold/80 sm:hidden">
              Log {logOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </button>
            <div ref={logRef} className={cn("log-scroll overflow-y-auto px-3 pb-2 font-mono text-[12px] leading-[1.5] sm:h-[132px] sm:pt-2 sm:text-[12.5px]", logOpen ? "h-[38vh]" : "h-[64px]")}>
              {recentLog.map((l) => {
                const t = timeOf(l.tick);
                return (
                  <div key={l.id} className={LOG_COLOR[l.kind]}>
                    <span className="mr-2 text-parchment/30">[{t.label}]</span>
                    {l.text}
                  </div>
                );
              })}
            </div>
          </div>
        </main>

        {/* Desktop inspector */}
        <aside className="hidden w-[340px] shrink-0 overflow-y-auto border-l-2 border-frame/70 bg-night-2 p-3 lg:block">{inspector}</aside>
      </div>

      {/* Mobile inspector sheet */}
      {sel ? (
        <div className="fixed inset-x-0 bottom-0 z-30 max-h-[70dvh] overflow-y-auto rounded-t-xl border-t-2 border-frame bg-night-2 p-3 shadow-[0_-10px_30px_rgba(0,0,0,.5)] animate-in slide-in-from-bottom-8 duration-200 lg:hidden safe-bottom">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-pixel text-gold">Inspect</span>
            <button onClick={() => setSel(null)} className="grid h-10 w-10 place-items-center rounded-md text-parchment/80" aria-label="Close inspector"><X className="h-5 w-5" /></button>
          </div>
          {inspector}
          <p className="mt-2 text-center text-[11px] text-parchment/50">Tip: tap a selected tile again to travel there.</p>
        </div>
      ) : null}

      {/* hatch prompt: a ready egg asks to be kept or released */}
      {hatchEgg ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-night/80 p-4 backdrop-blur-[2px] animate-in fade-in duration-150">
          <button className="absolute inset-0 cursor-default" onClick={() => act((g) => postponeHatch(g, hatchEgg.id))} aria-label="Decide later" />
          <div className="relative w-full max-w-sm rounded-lg border-2 border-ember/60 bg-night-2 p-4 text-center shadow-[0_20px_60px_rgba(0,0,0,.6)] animate-in zoom-in-95 slide-in-from-bottom-4 duration-200">
            <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full border-2 border-frame bg-night">
              <Portrait speciesId={hatchEgg.speciesId} size={46} />
            </div>
            <div className="font-pixel text-[15px] text-gold">An egg is hatching</div>
            <p className="mt-1.5 font-mono text-[12px] leading-relaxed text-parchment/80">
              The shell splits. A young <span className="text-parchment">{SPECIES[hatchEgg.speciesId].name}</span> blinks up at you — the first thing it ever sees.
            </p>
            {hatchEgg.child.parentNames ? (
              <p className="mt-1 font-mono text-[11px] text-parchment/50">Bloodline of {hatchEgg.child.parentNames[0]} × {hatchEgg.child.parentNames[1]}</p>
            ) : null}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button className="btn-game btn-ember h-12 text-[13px]" onClick={() => decideEgg(hatchEgg.id, "keep")}>Keep it</button>
              <button className="btn-game btn-night h-12 text-[13px]" onClick={() => decideEgg(hatchEgg.id, "release")}>Release it</button>
            </div>
            <button className="mt-2 h-9 w-full font-mono text-[11.5px] text-parchment/60 hover:text-parchment" onClick={() => act((g) => postponeHatch(g, hatchEgg.id))}>
              Not yet — it can wait in the shell
            </button>
            <p className="mt-1.5 text-[11px] leading-snug text-parchment/45">Keep hatches it tame at your side. Release lets it live wild and free — it will remember you.</p>
          </div>
        </div>
      ) : null}
      <PartySheet gs={state} open={sheet === "party"} onClose={() => setSheet(null)} atSettlement={atSettlement} />
      <BagSheet gs={state} open={sheet === "bag"} onClose={() => setSheet(null)} />
      <BestiarySheet open={sheet === "bestiary"} onClose={() => setSheet(null)} />
      <CampSheet gs={state} open={sheet === "camp"} onClose={() => setSheet(null)} onEngage={(id) => handleResult({ ok: true, engaged: id })} />
      <StandingSheet gs={state} open={sheet === "standing"} onClose={() => setSheet(null)} />
      <NpcSheet gs={state} open={!!npcTalk} npc={npcTalk} onClose={() => setNpcTalk(null)} onParty={() => { setNpcTalk(null); setSheet("party"); }} />
      {feature?.kind === "shrine" ? <ShrineSheet gs={state} open={sheet === "shrine"} onClose={() => setSheet(null)} name={feature.name} /> : null}
      <NoticesSheet gs={state} open={sheet === "notices"} onClose={() => setSheet(null)} settlement={feature && isSettlement(feature) ? feature : null} />
      <OfferSheet gs={state} open={sheet === "offer"} onClose={() => setSheet(null)} creatureId={offerId} onEngage={(id) => handleResult({ ok: true, engaged: id })} />
    </div>
  );
}

function TopTab({ icon: Icon, label, onClick }: { icon: typeof PawPrint; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-pixel text-[14px] text-parchment/85 hover:bg-white/5 hover:text-parchment sm:px-3">
      <Icon className="h-5 w-5" />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

function ActBtn({ icon: Icon, label, onClick, disabled, primary, className, badge }: { icon: typeof PawPrint; label: string; onClick: () => void; disabled?: boolean; primary?: boolean; className?: string; badge?: string }) {
  return (
    <button onClick={onClick} disabled={disabled} className={cn("btn-game h-11 shrink-0 px-3 text-[13px]", primary ? "btn-ember" : "btn-night", className)}>
      <Icon className="h-4 w-4" />
      {label}
      {badge ? <span className="ml-0.5 rounded bg-ember/30 px-1 font-mono text-[10px] text-gold">{badge}</span> : null}
    </button>
  );
}

function DPad({ onStep, onWait }: { onStep: (dx: number, dy: number) => void; onWait: () => void }) {
  const cell = "grid h-12 w-12 place-items-center rounded-md border-2 border-frame/80 bg-night/80 text-parchment backdrop-blur-sm active:scale-90 active:bg-ember/40 transition-transform";
  const diag = "grid h-12 w-12 place-items-center rounded-md text-parchment/50 active:scale-90 active:bg-ember/30 transition-transform";
  return (
    <div className="absolute bottom-2 right-2 grid grid-cols-3 gap-1 opacity-95 lg:opacity-80" aria-label="Movement pad">
      <button className={diag} onClick={() => onStep(-1, -1)} aria-label="North-west">↖</button>
      <button className={cell} onClick={() => onStep(0, -1)} aria-label="North"><ChevronUp className="h-6 w-6" /></button>
      <button className={diag} onClick={() => onStep(1, -1)} aria-label="North-east">↗</button>
      <button className={cell} onClick={() => onStep(-1, 0)} aria-label="West"><ChevronLeft className="h-6 w-6" /></button>
      <button className={cn(cell, "font-pixel text-xs")} onClick={onWait} aria-label="Wait a turn">wait</button>
      <button className={cell} onClick={() => onStep(1, 0)} aria-label="East"><ChevronRight className="h-6 w-6" /></button>
      <button className={diag} onClick={() => onStep(-1, 1)} aria-label="South-west">↙</button>
      <button className={cell} onClick={() => onStep(0, 1)} aria-label="South"><ChevronDown className="h-6 w-6" /></button>
      <button className={diag} onClick={() => onStep(1, 1)} aria-label="South-east">↘</button>
    </div>
  );
}
