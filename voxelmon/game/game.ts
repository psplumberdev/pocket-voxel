// The Game shell: the state stack (overworld / textbox / stub-battle /
// warp-fade), the per-tick drive, and the boot that skips title/intro
// straight into the overworld like the reference test driver
// (tests/drivers/util.lua U.newGame ends standing in the bedroom;
// src/core/SaveData.lua:1345 newGame pins the spawn).
//
// One guest turn per host tick: tick(buttons) exactly once (docs/VOXEL.md
// §3). The tick is: input edges -> update the TOP state only (the Lua
// StateStack rule — everything beneath is frozen, which is also what makes
// the frame a script/box closes non-actionable for the world below) ->
// presentation emit -> frameDone.

import { fromSection, type AudioBanks } from "./audio/banks.ts";
import { AudioDirector } from "./audio/music.ts";
import { WildBattle } from "./battle/battle.ts";
import { healMon, newMon, partyAdd, type PartyMon } from "./battle/mon.ts";
import { computeStaging, type BattleStaging } from "./battle/staging.ts";
import { BattleUi } from "./battle/ui.ts";
import type { VoxelmonData } from "./data.ts";
import type { VoxelHost } from "./host.ts";
import { Input } from "./input.ts";
import { seededRng, type Rng } from "./rng.ts";
import * as Bag from "./rules/bag.ts";
import {
  MAX_MONEY,
  STARTING_MONEY,
  moneyAfterBlackout,
  sellPrice,
  trainerPayout,
} from "./rules/economy.ts";
import { apply as applyEvolution, checkParty } from "./rules/evolution.ts";
import { movesLearnedAt } from "./rules/experience.ts";
import { MAP_ENTRY_AFTER_BATTLE, POST_BATTLE_RETURN, YES_NO_ANSWER } from "./rules/timing.ts";
import {
  PC_DEX_ROWS,
  PC_HOME_ROWS,
  PC_MAIL_ROWS,
  type PcDesktopPage,
  type PcDesktopSource,
  type PcPartyRow,
} from "./ui/pc-desktop.ts";
import type { RemotePcSource, RemotePcStatus } from "./ui/remote-desktop.ts";
import {
  Scene,
  type BattleSceneView,
  type ChoiceSource,
  type Prof,
  type SceneView,
  type SystemOverlaySource,
  type UiBoxSource,
} from "./scene.ts";
import { Overworld, type OverworldShell, type SaveSlice } from "./world/overworld.ts";
import { Textbox } from "./world/textbox.ts";

/** The full save: the overworld slice plus the party the battle port added. */
export interface GameSave extends SaveSlice {
  party: PartyMon[];
  /** Runtime performance option: false keeps the PSP audio path idle. */
  musicEnabled?: boolean;
}

interface SaveFileV1 {
  version: 1;
  save: GameSave;
  location: { map: string; x: number; y: number; facing: "up" | "down" | "left" | "right" };
}

export interface GameState {
  readonly kind: string;
  update(): void;
}

class OverworldState implements GameState {
  readonly kind = "overworld";
  constructor(private ow: Overworld) {}
  update(): void {
    this.ow.update();
  }
}

class TitleState implements GameState, SystemOverlaySource {
  readonly kind = "title";
  revision = 0;
  private menu = false;
  private selected = 0;
  private readonly hasContinue: boolean;

  constructor(private game: VoxelmonGame) {
    this.hasContinue = game.hasSave();
  }

  update(): void {
    const input = this.game.input;
    if (!this.menu) {
      if (input.wasPressed("a") || input.wasPressed("start")) {
        this.menu = true;
        this.revision += 1;
      }
      return;
    }
    const rows = this.hasContinue ? 2 : 1;
    if (input.wasPressed("up")) {
      this.selected = (this.selected + rows - 1) % rows;
      this.revision += 1;
    } else if (input.wasPressed("down")) {
      this.selected = (this.selected + 1) % rows;
      this.revision += 1;
    } else if (input.wasPressed("a") || input.wasPressed("start")) {
      if (this.hasContinue && this.selected === 0 && this.game.loadGame()) return;
      this.game.startNewGameIntro();
    }
  }

  emit(host: VoxelHost): void {
    host.uiRect(0, 0, 480, 272, 0xff000000);
    host.uiLabel(78, 40, 4, 0xffffffff, "POKEMON");
    host.uiLabel(164, 94, 2, 0xff6060ff, "RED VERSION");
    host.uiLabel(128, 228, 1, 0xffffffff, "1995 GAME FREAK INC.");
    if (!this.menu) {
      host.uiLabel(164, 178, 1, 0xffffffff, "PRESS START");
      return;
    }
    const labels = this.hasContinue ? ["CONTINUE", "NEW GAME"] : ["NEW GAME"];
    for (let i = 0; i < labels.length; i++) {
      host.uiLabel(170, 158 + i * 20, 1, 0xffffffff, `${i === this.selected ? ">" : " "} ${labels[i]}`);
    }
  }
}

class IntroState implements GameState {
  readonly kind = "intro";
  constructor(private game: VoxelmonGame) {}
  update(): void {}
  begin(): void {
    this.game.showText("Hello there!\nWelcome to the world\nof POKéMON!", () => {
      this.game.showText("My name is OAK!\nPeople call me the\nPOKéMON PROF!", () => {
        this.game.showMenuChoice("First, what is\nyour name?", ["RED", "ASH", "JACK"], (i) => {
          this.game.save.player.name = ["RED", "ASH", "JACK"][i] ?? "RED";
          this.game.showMenuChoice("What is your\nrival's name?", ["BLUE", "GARY", "JOHN"], (j) => {
            this.game.save.player.rival = ["BLUE", "GARY", "JOHN"][j] ?? "BLUE";
            this.game.showText(
              `${this.game.save.player.name}! Your very own\nPOKéMON legend is\nabout to unfold!`,
              () => this.game.pop(),
            );
          });
        });
      });
    });
  }
}

class StartMenuState implements GameState, SystemOverlaySource {
  readonly kind = "start-menu";
  revision = 0;
  private selected = 0;
  private status = "";
  private get labels(): readonly string[] {
    return ["POKEMON", "ITEM", `MUSIC ${this.game.musicEnabled ? "ON" : "OFF"}`, "SAVE", "EXIT"];
  }
  constructor(private game: VoxelmonGame) {}
  update(): void {
    const input = this.game.input;
    if (input.wasPressed("b") || input.wasPressed("start")) {
      this.game.pop();
      return;
    }
    if (input.wasPressed("up")) this.selected = (this.selected + this.labels.length - 1) % this.labels.length;
    else if (input.wasPressed("down")) this.selected = (this.selected + 1) % this.labels.length;
    else if (input.wasPressed("a")) {
      if (this.selected === 0) { this.game.pop(); this.game.openParty(); return; }
      if (this.selected === 1) { this.game.pop(); this.game.openBag(); return; }
      if (this.selected === 2) {
        this.game.setMusicEnabled(!this.game.musicEnabled);
        this.status = this.game.musicEnabled ? "SLOW WALK" : "NORMAL WALK";
      } else if (this.selected === 3) {
        this.status = this.game.saveGame() ? "GAME SAVED." : "SAVE FAILED!";
      } else if (this.selected === 4) { this.game.pop(); return; }
    } else return;
    this.revision += 1;
  }
  emit(host: VoxelHost): void {
    host.uiRect(286, 18, 176, 204, 0xff000000);
    for (let i = 0; i < this.labels.length; i++) {
      host.uiLabel(322, 38 + i * 28, 1, 0xffffffff, `${i === this.selected ? ">" : " "} ${this.labels[i]}`);
    }
    if (this.status) host.uiLabel(304, 188, 1, 0xffffffff, this.status);
  }
}

interface MenuChoice {
  labels: readonly string[];
  choose(index: number): void;
}

class TextBoxState implements GameState, UiBoxSource {
  readonly kind = "textbox";
  readonly box: Textbox;
  private choicePushed = false;
  constructor(
    private game: VoxelmonGame,
    text: string,
    private onDone?: () => void,
    private choice?: MenuChoice,
  ) {
    this.box = new Textbox(text, {
      player: game.save.player.name,
      rival: game.save.player.rival,
    });
  }
  update(): void {
    // opts.choice (TextBox.lua:255): once the last page has typed out, the
    // YES/NO menu pops up over the still-visible text — before the box's
    // done-state can consume A as a close.
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice.labels, this.choice.choose));
      }
      return;
    }
    const wasWaiting = this.box.waiting;
    const wasDone = this.box.done;
    this.box.update(this.game.input);
    // TextBox.lua:269 and :284 — A/B both close a finished box and advance a
    // waiting one, and each plays the Press_AB beep.
    if ((wasDone && this.box.closed) || (wasWaiting && !this.box.waiting)) {
      this.game.audio.playSfx("Press_AB");
    }
    if (this.choice && this.box.done) {
      if (!this.choicePushed) {
        this.choicePushed = true;
        this.game.push(new ChoiceState(this.game, this.choice.labels, this.choice.choose));
      }
      return;
    }
    if (this.box.closed) {
      this.game.pop();
      this.onDone?.();
    }
  }
}

class ChoiceState implements GameState, ChoiceSource {
  readonly kind = "choice";
  private cursor: number;
  /** Four-row viewport consumed by Scene's fixed-size choice window. */
  get labels(): readonly string[] {
    const start = Math.max(0, Math.min(this.cursor - 3, this.allLabels.length - 4));
    return this.allLabels.slice(start, start + 4);
  }
  get selected(): number {
    const start = Math.max(0, Math.min(this.cursor - 3, this.allLabels.length - 4));
    return this.cursor - start;
  }
  /** The answer given, held on screen before it is handed back. */
  private pending: number | null = null;
  private holdFrames = 0;
  constructor(
    private game: VoxelmonGame,
    private readonly allLabels: readonly string[],
    private cb: (index: number) => void,
    opts?: { defaultNo?: boolean; noSound?: boolean },
  ) {
    if (allLabels.length < 2) {
      throw new Error("a choice needs at least two labels");
    }
    // ChoiceBox.lua:16 — some of the original's prompts open on NO
    this.cursor = opts?.defaultNo ? allLabels.length - 1 : 0;
    this.noSound = opts?.noSound === true;
  }
  private readonly noSound: boolean;
  /** Compatibility name for the original YES/NO call sites. */
  get yes(): boolean {
    return this.cursor === 0;
  }
  update(): void {
    const input = this.game.input;
    // ChoiceBox.lua:34-45: BOTH branches of DisplayTwoOptionMenu hold 15
    // frames with the menu still up before TwoOptionMenu_RestoreScreenTiles
    // hands control back (engine/menus/text_box.asm:322-323, :333-334).
    if (this.pending !== null) {
      this.holdFrames -= 1;
      if (this.holdFrames <= 0) {
        const selected = this.pending;
        this.pending = null;
        this.game.pop(); // this choice
        this.game.pop(); // the text box under it (ChoiceBox pops both)
        this.cb(selected);
      }
      return;
    }
    if (input.wasPressed("up")) {
      this.cursor = (this.cursor + this.allLabels.length - 1) % this.allLabels.length;
    } else if (input.wasPressed("down")) {
      this.cursor = (this.cursor + 1) % this.allLabels.length;
    } else if (input.wasPressed("a")) {
      // HandleMenuInput_ (home/window.asm): SFX_PRESS_AB on A and B alike
      if (!this.noSound) this.game.audio.playSfx("Press_AB"); // ChoiceBox.lua:53
      this.pending = this.cursor;
      this.holdFrames = YES_NO_ANSWER;
    } else if (input.wasPressed("b")) {
      if (!this.noSound) this.game.audio.playSfx("Press_AB"); // ChoiceBox.lua:59
      // .choseSecondMenuItem writes wCurrentMenuItem = 1 BEFORE the hold, so
      // the cursor visibly snaps to NO for those 15 frames
      this.cursor = this.allLabels.length - 1;
      this.pending = this.cursor;
      this.holdFrames = YES_NO_ANSWER;
    }
  }
}

/**
 * The local bedroom computer. It is a real stack state: while it is topmost,
 * the overworld underneath receives no input. Rendering is delegated through
 * PcDesktopSource, so the controller knows nothing about PSP/Vita drawing.
 */
class PcDesktopState implements GameState, PcDesktopSource {
  readonly kind = "pc-desktop";
  revision = 0;
  page: PcDesktopPage = "home";
  selected = 0;
  status = "4 OBJECTS";
  readonly trainerName: string;
  boxNumber = 1;
  readonly readMail = [false, false, false];
  readonly party: readonly PcPartyRow[];

  constructor(private game: VoxelmonGame) {
    this.trainerName = game.save.player.name;
    this.party = game.save.party.map((mon) => ({
      name: mon.nickname ?? game.data.pokemon[mon.species]?.name ?? mon.species,
      level: mon.level,
      hp: mon.hp,
      maxHp: mon.stats.hp,
    }));
  }

  update(): void {
    const input = this.game.input;
    if (input.wasPressed("start")) {
      this.close();
      return;
    }
    if (input.wasPressed("b")) {
      this.game.audio.playSfx("Press_AB");
      if (this.page === "home") {
        this.close(false);
      } else {
        this.page = "home";
        this.selected = 0;
        this.status = "4 OBJECTS";
        this.changed();
      }
      return;
    }

    const count = this.rowCount();
    if (input.wasPressed("up")) {
      this.selected = (this.selected + count - 1) % count;
      this.changed();
      return;
    }
    if (input.wasPressed("down")) {
      this.selected = (this.selected + 1) % count;
      this.changed();
      return;
    }
    if (this.page === "storage" && (input.wasPressed("left") || input.wasPressed("right"))) {
      const delta = input.wasPressed("left") ? -1 : 1;
      this.boxNumber = ((this.boxNumber - 1 + delta + 12) % 12) + 1;
      this.status = `BOX ${String(this.boxNumber).padStart(2, "0")} ONLINE`;
      this.changed();
      return;
    }
    if (!input.wasPressed("a")) return;
    this.game.audio.playSfx("Press_AB");
    this.activate();
  }

  private rowCount(): number {
    switch (this.page) {
      case "pokedex":
        return PC_DEX_ROWS.length;
      case "storage":
        return Math.max(1, this.party.length);
      case "mail":
        return PC_MAIL_ROWS.length;
      default:
        return PC_HOME_ROWS.length;
    }
  }

  private activate(): void {
    if (this.page === "home") {
      if (this.selected === 3) {
        this.close(false);
        return;
      }
      this.page = (["pokedex", "storage", "mail"] as const)[this.selected]!;
      this.selected = 0;
      this.status =
        this.page === "pokedex"
          ? "3 SPECIES INDEXED"
          : this.page === "storage"
            ? "BOX 01 ONLINE"
            : `${this.readMail.filter((read) => !read).length} NEW MESSAGES`;
      this.changed();
      return;
    }
    if (this.page === "pokedex") {
      this.status = `${PC_DEX_ROWS[this.selected]!.slice(0, 3)} DATA LOADED`;
    } else if (this.page === "storage") {
      this.status = `BOX ${String(this.boxNumber).padStart(2, "0")} SYNC COMPLETE`;
    } else {
      this.readMail[this.selected] = true;
      this.status = `${PC_MAIL_ROWS[this.selected]} MESSAGE READ`;
    }
    this.changed();
  }

  private changed(): void {
    this.revision += 1;
  }

  private close(playPress = true): void {
    if (playPress) this.game.audio.playSfx("Press_AB");
    this.game.audio.playSfx("Turn_Off_PC");
    this.game.pop();
  }
}

/** Retry cadence for an absent host stream. One attempt per half-second keeps
 * device I/O cheap while still making a daemon started after the modal opens
 * appear without leaving and re-entering the PC. */
const REMOTE_OPEN_RETRY_TICKS = 30;

/**
 * The remote bedroom computer. This is a real modal stack state like the
 * local desktop: the overworld stays frozen, while the host owns stream I/O
 * and the guest owns only WAITING/LIVE presentation and close policy.
 */
class RemotePcState implements GameState, RemotePcSource {
  readonly kind = "pc-remote";
  revision = 0;
  status: RemotePcStatus = "waiting";
  frameIndex = -1;
  private opened = false;
  private retryIn = 0;

  constructor(private game: VoxelmonGame) {}

  update(): void {
    const input = this.game.input;
    if (input.wasPressed("b") || input.wasPressed("start")) {
      this.close();
      return;
    }

    if (!this.opened) {
      if (this.retryIn > 0) {
        this.retryIn -= 1;
        return;
      }
      this.opened = this.game.host.remoteOpen();
      this.retryIn = REMOTE_OPEN_RETRY_TICKS;
      if (!this.opened) return;
    }

    const frameIndex = this.game.host.remoteTick();
    if (frameIndex === -2) {
      this.game.host.remoteClose();
      this.opened = false;
      this.retryIn = REMOTE_OPEN_RETRY_TICKS;
      this.frameIndex = -1;
      if (this.status !== "waiting") {
        this.status = "waiting";
        this.revision += 1;
      }
      return;
    }
    this.frameIndex = frameIndex;
    const status: RemotePcStatus = frameIndex >= 0 ? "live" : "waiting";
    if (status !== this.status) {
      this.status = status;
      this.revision += 1;
    }
  }

  private close(): void {
    this.game.audio.playSfx("Press_AB");
    this.game.host.remoteClose();
    this.game.audio.playSfx("Turn_Off_PC");
    this.game.pop();
  }
}

// The warp fade: 32 ticks of held world (Timing WARP_FADE_OUT — pokered
// GBFadeOutToBlack), the map switch at the midpoint, no fade back in
// (WARP_FADE_IN = 0: LoadGBPal restores the palettes in one write).
class WarpFadeState implements GameState {
  readonly kind = "warpfade";
  constructor(
    private game: VoxelmonGame,
    private frames: number,
    private midpoint: () => void,
    private onDone?: () => void,
  ) {}
  update(): void {
    this.frames -= 1;
    if (this.frames <= 0) {
      this.game.pop();
      this.midpoint();
      this.onDone?.();
    }
  }
}

// The real wild battle (replacing the overworld slice's StubBattle seam):
// the gen1recomp BattleState port in battle/battle.ts, staged in the voxel
// arena (battle/staging.ts) and drawn through the GB tile layer
// (battle/ui.ts). This state owns the battle's lifetime on the stack; the
// scene reads it through SceneView.battleView().
class BattleGameState implements GameState, BattleSceneView {
  readonly kind = "battle";
  battle: WildBattle;
  readonly staging: BattleStaging | null;
  readonly ui = new BattleUi();
  private trainerIndex = 0;

  constructor(
    private game: VoxelmonGame,
    species: string,
    level: number,
    private trainer?: {
      name: string;
      trainerClass: string;
      party: readonly { species: string; level: number }[];
      onWin: () => void;
    },
  ) {
    this.battle = new WildBattle(
      game.data,
      game.save,
      game.battleRng,
      species,
      level,
      trainer ? { name: trainer.name } : undefined,
    );
    // stage where the player stands; nothing moves the player — the camera
    // goes to the arena (docs/VOXEL.md §4)
    const ow = game.overworld;
    this.staging = computeStaging(ow.map, ow.player.cellX, ow.player.cellY, ow.player.surfing);
    this.battle.enter();
  }

  update(): void {
    const b = this.battle;
    if (b.finished) {
      const next = this.trainer?.party[this.trainerIndex + 1];
      if (b.finished === "win" && next) {
        this.trainerIndex += 1;
        this.battle = new WildBattle(
          this.game.data,
          this.game.save,
          this.game.battleRng,
          next.species,
          next.level,
          { name: this.trainer!.name },
        );
        this.battle.enter();
        return;
      }
      // BattleState.lua:4647-4653 — teardown pops the battle screen FIRST,
      // and it is the map that holds: POST_BATTLE_RETURN before EnterMap
      // (home/overworld.asm:351-352) and then MapEntryAfterBattle's
      // GBFadeInFromWhite (:22, :749-753). The port renders both as held
      // frames, the convention WarpFadeState already uses for the warp fade.
      this.game.pop();
      // OverworldController.lua:3851-3894 afterBattle: the blackout warps to
      // the heal point FIRST and takes evolutions() as its callback (:3882),
      // every other exit runs them straight away (:3892).
      if (b.finished === "lose") this.game.blackout();
      this.game.pushWarpFade(
        POST_BATTLE_RETURN + MAP_ENTRY_AFTER_BATTLE,
        () => {},
        () => {
          this.game.runEvolutions(b.leveledUp);
          if (b.finished === "win" && this.trainer) {
            this.game.awardTrainerMoney(
              this.trainer.name,
              this.trainer.trainerClass,
              this.trainer.party,
              this.trainer.onWin,
            );
          }
        },
      );
      return;
    }
    b.update(this.game.input);
  }
}

export class VoxelmonGame implements OverworldShell, SceneView {
  readonly data: VoxelmonData;
  readonly host: VoxelHost;
  readonly input = new Input();
  /** Encounter roll stream. Tests may swap it after construction. */
  rng: Rng;
  /** NPC wander stream — separate so ambience can't perturb encounters. */
  npcRng: Rng;
  /** Battle stream — separate so in-battle rolls (enemy DVs, crits, catch
   * wobbles) can never perturb the overworld route's determinism. */
  battleRng: Rng;
  save!: GameSave;
  overworld!: Overworld;
  /** Music, SFX and cries: the POLICY, emitting audio ops. Silent until a
   *  caller hands it the manifest — setAudio(banks) on the Bun transport,
   *  setAudioFromPak() on device. A director with no manifest emits nothing. */
  audio = new AudioDirector(null);
  /** OFF is the PSP-friendly default; ON trades walking speed for music. */
  musicEnabled = false;
  private deviceAudioReady = false;
  private stack: GameState[] = [];
  private scene: Scene;
  tickIndex = 0;
  /** Autopilot-only profiling hook (psp-main.ts installs it when the native
   * surface carries `now`/`perf` — the perf-runbook EBOOT alone). Splits
   * tick() into update / scene-emit / audio (and emit into its sections,
   * scene.ts) and reports 300-tick µs sums. Undefined in production and in
   * the Bun sim; gameplay never reads it. */
  prof?: Prof;
  // audio policy observation (the reference calls Music/Sound from the sites
  // themselves; the port watches the same state transitions from one place)
  private audioMap: string | null = null;
  private audioBattle = false;
  private audioRestored = false;

  constructor(data: VoxelmonData, host: VoxelHost, seed = 1) {
    this.data = data;
    this.host = host;
    this.rng = seededRng(seed >>> 0);
    // decorrelated second stream (fixed odd offset keeps seed 0 distinct)
    this.npcRng = seededRng(((seed >>> 0) ^ 0x9e3779b9) >>> 0);
    // third stream for battles (same decorrelation trick, distinct constant)
    this.battleRng = seededRng(((seed >>> 0) ^ 0x85ebca6b) >>> 0);
    this.scene = new Scene(host);
  }

  /**
   * Install the audio manifest — `null` means NO manifest, which is total
   * silence: the director resolves nothing and emits no op. Pass the Bun
   * transport's manifest (gen/audio.json); `setAudioFromPak()` is the device
   * path.
   *
   * The `audiodata` op fires either way, on EVERY host, so a recorded trace
   * carries the same op stream a device run replays (SCHEMA.md ".vtrace").
   * Only setAudioFromPak() reads the answer.
   */
  setAudio(banks: AudioBanks | null): void {
    void this.host.audiodata();
    this.audio = new AudioDirector(banks, this.host);
  }

  /**
   * Load the audio manifest from the pak's AUDI section, over the `audiodata`
   * op — the device transport. Only the JSON half is parsed; the programs
   * stay in the pak, where the core reads them (banks.ts fromSection). A pak
   * cooked without audio answers null and the director stays silent.
   */
  setAudioFromPak(): void {
    this.audio = new AudioDirector(fromSection(this.host.audiodata()), this.host);
  }

  /** Called after the PSP has mounted the resident AUDIO section. */
  enableDeviceAudio(): void {
    this.deviceAudioReady = true;
    if (this.musicEnabled) this.startEnabledAudio();
  }

  /** Start-menu performance switch: silent/normal or music/slower walking. */
  setMusicEnabled(enabled: boolean): void {
    if (this.musicEnabled === enabled) return;
    this.musicEnabled = enabled;
    this.save.musicEnabled = enabled;
    this.applyMovementSpeed();
    if (enabled) this.startEnabledAudio();
    else {
      this.audio.stop();
      this.audio = new AudioDirector(null);
    }
  }

  private startEnabledAudio(): void {
    if (!this.deviceAudioReady) return;
    this.setAudioFromPak();
    this.audioMap = this.overworld.map.id;
    this.audio.startMap(this.audioMap);
  }

  private applyMovementSpeed(): void {
    if (!this.overworld?.player) return;
    this.overworld.player.stepFrames = this.musicEnabled ? 24 : 16;
  }

  /**
   * The audio policy, ported from the reference's call sites: map themes on
   * map entry (Music.lua:339 playMap), the battle theme and the wild mon's
   * cry on encounter (BattleState.lua:1458, :1496-1498), the victory jingle
   * the moment the win is decided (Music.lua:370), and the map theme back
   * when the battle closes (:407 restoreMap).
   */
  private driveAudio(): void {
    const bv = this.battleView();
    if (bv) {
      if (!this.audioBattle) {
        this.audioBattle = true;
        // play_battle_music.asm runs before the transition (:1458); the cry
        // and the victory theme are NOT observed from out here — the battle
        // queues them where the reference does and we drain them below.
        this.audio.playBattle("wild");
      }
      this.drainBattleCues(bv.battle);
      return;
    }
    if (this.audioBattle) {
      this.audioBattle = false;
      // the battle's own finish() already queued music:restore; this is the
      // backstop for a battle torn down without one
      if (!this.audioRestored) this.audio.restore();
      this.audioRestored = false;
      return;
    }
    const mapId = this.overworld.map.id;
    // A connection crossing switches the map at the START of the seam step;
    // its theme is owed to the frame the step LANDS (OverworldController.lua:
    // 1075), and the overworld pays it through startMapMusic. Observing the
    // map id here would jump the gun by a whole step.
    if (mapId !== this.audioMap && !this.overworld.pendingSeamMusic) {
      this.audioMap = mapId;
      this.audio.startMap(mapId);
    }
  }

  /** Play what the battle queued, in the order it queued it. */
  private drainBattleCues(battle: WildBattle): void {
    const cues = battle.audioCues;
    for (const cue of cues) {
      if (cue.startsWith("cry:")) {
        this.audio.playCry(cue.slice(4));
      } else if (cue.startsWith("sfx:")) {
        this.audio.playSfx(cue.slice(4));
      } else if (cue === "music:victory") {
        // Music.playVictory only has a jingle for a won fight
        this.audio.playVictory("wild");
      } else if (cue === "music:restore") {
        this.audio.restore();
        this.audioRestored = true;
        this.audioMap = this.overworld.map.id;
      }
    }
    cues.length = 0;
  }

  /**
   * Boot straight into the overworld, skipping title/intro like the
   * reference driver's U.newGame: SaveData.lua:1345 pins the spawn at
   * REDS_HOUSE_2F (3,6) facing down. `lastOutdoor` remains Pallet so the 1F
   * exit mat works before the player has ever been outdoors; the gameplay
   * checkpoint is Mom's house until a Pokémon Center nurse replaces it.
   */
  newGame(): void {
    this.save = {
      // Oak's Pallet grass event is live; the party stays empty until the
      // player confirms one of the three balls in Oak's lab.
      flags: {},
      inventory: {},
      money: STARTING_MONEY,
      musicEnabled: false,
      player: { name: "RED", rival: "BLUE" },
      lastHeal: { map: "REDS_HOUSE_1F", x: 4, y: 6 },
      lastOutdoor: { id: "PALLET_TOWN", x: 5, y: 6 },
      party: [],
    };
    this.overworld = new Overworld(this);
    this.stack = [new OverworldState(this.overworld)];
    this.overworld.enter("REDS_HOUSE_2F", 3, 6, "down");
    this.musicEnabled = false;
    this.applyMovementSpeed();
  }

  boot(): void {
    this.newGame();
    this.push(new TitleState(this));
  }

  startNewGameIntro(): void {
    this.newGame();
    const intro = new IntroState(this);
    this.push(intro);
    intro.begin();
  }

  hasSave(): boolean {
    const raw = this.host.saveLoad?.();
    if (!raw) return false;
    try { return (JSON.parse(raw) as { version?: unknown }).version === 1; }
    catch { return false; }
  }

  chooseStarter(species: "BULBASAUR" | "CHARMANDER" | "SQUIRTLE"): void {
    if (this.save.flags.EVENT_GOT_STARTER) return;
    this.save.party.push(
      newMon(this.data, species, 5, undefined, {
        hp: 0,
        attack: 0,
        defense: 0,
        speed: 0,
        special: 0,
      }),
    );
    this.save.flags.EVENT_GOT_STARTER = true;
    this.save.flags[`EVENT_CHOSE_${species}`] = true;
    const rival = species === "BULBASAUR" ? "CHARMANDER" : species === "CHARMANDER" ? "SQUIRTLE" : "BULBASAUR";
    this.save.flags[`EVENT_RIVAL_CHOSE_${rival}`] = true;
  }

  buyMagikarp(): "bought" | "money" | "party-full" | "already-bought" {
    if (this.save.flags.EVENT_BOUGHT_MAGIKARP) return "already-bought";
    const money = this.save.money ?? 0;
    if (money < 500) return "money";
    const mon = newMon(this.data, "MAGIKARP", 5);
    if (!partyAdd(this.save.party, mon)) return "party-full";
    this.save.money = money - 500;
    this.save.flags.EVENT_BOUGHT_MAGIKARP = true;
    return "bought";
  }

  saveGame(): boolean {
    const p = this.overworld.player;
    const file: SaveFileV1 = {
      version: 1,
      save: this.save,
      location: { map: this.overworld.map.id, x: p.cellX, y: p.cellY, facing: p.facing },
    };
    return this.host.saveWrite?.(JSON.stringify(file)) ?? false;
  }

  loadGame(): boolean {
    const raw = this.host.saveLoad?.();
    if (!raw) return false;
    try {
      const file = JSON.parse(raw) as Partial<SaveFileV1>;
      const loc = file.location;
      const save = file.save;
      if (
        file.version !== 1 || !save || !loc ||
        !this.data.maps?.[loc.map] || !Number.isInteger(loc.x) || !Number.isInteger(loc.y) ||
        !["up", "down", "left", "right"].includes(loc.facing) ||
        !Array.isArray(save.party) || typeof save.flags !== "object" ||
        typeof save.inventory !== "object" || typeof save.player?.name !== "string"
      ) return false;
      this.save = save;
      this.save.money = Math.max(0, Math.min(MAX_MONEY, Math.floor(this.save.money ?? STARTING_MONEY)));
      this.musicEnabled = this.save.musicEnabled === true;
      this.overworld = new Overworld(this);
      this.stack = [new OverworldState(this.overworld)];
      this.overworld.enter(loc.map, loc.x, loc.y, loc.facing);
      this.applyMovementSpeed();
      if (this.musicEnabled) this.startEnabledAudio();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The blackout path a lost battle takes (pokered HandleBlackOut,
   * engine/battle/core.asm:1157+: heal the party, special-warp to the last
   * Pokémon center), including ResetStatusAndHalveMoneyOnBlackout.
   */
  blackout(): void {
    this.save.money = moneyAfterBlackout(this.save.money ?? 0);
    for (const mon of this.save.party) healMon(this.data, mon);
    const saved = this.save.lastHeal;
    // Old saves used PALLET_TOWN as the zero-checkpoint. Treat that legacy
    // outdoor value (and a missing/corrupt value) as Mom's house. A nurse
    // records a concrete *_POKECENTER map and always wins thereafter.
    const heal = saved?.map.endsWith("POKECENTER")
      ? saved
      : { map: "REDS_HOUSE_1F", x: 4, y: 6 };
    this.save.lastHeal = heal;
    // A blackout is a special relocation, not travel from the defeated map.
    // Preserve lastOutdoor so the Center door still exits to its real town.
    this.overworld.startWarpTo(heal.map, heal.x, heal.y, "down", undefined, false);
  }

  /** One guest turn per host tick — exactly once. */
  tick(buttons: number): void {
    const p = this.prof;
    const t0 = p ? p.now() : 0;
    this.input.setButtons(buttons);
    this.input.step();
    const top = this.stack[this.stack.length - 1];
    top?.update();
    const t1 = p ? p.now() : 0;
    this.scene.emit(this);
    const t2 = p ? p.now() : 0;
    this.driveAudio();
    this.host.frameDone(this.tickIndex, buttons);
    if (p) {
      p.upd += t1 - t0;
      p.emit += t2 - t1;
      p.aud += p.now() - t2;
      if (this.tickIndex % 300 === 299) {
        p.line(
          `j${this.tickIndex} upd ${Math.round(p.upd)} emit ${Math.round(p.emit)}` +
            ` aud ${Math.round(p.aud)} maps ${Math.round(p.maps)}` +
            ` ents ${Math.round(p.ents)} ui ${Math.round(p.ui)}`,
        );
        p.upd = p.emit = p.aud = p.maps = p.ents = p.ui = 0;
      }
    }
    this.tickIndex += 1;
  }

  // stack ---------------------------------------------------------------

  push(state: GameState): void {
    this.stack.push(state);
  }

  pop(): void {
    this.stack.pop();
  }

  top(): GameState | undefined {
    return this.stack[this.stack.length - 1];
  }

  stackKinds(): string[] {
    return this.stack.map((s) => s.kind);
  }

  // OverworldShell ------------------------------------------------------

  /** Commands.lua:587 heal_party — Pokemon.lua:90 heal over the party. */
  healParty(): void {
    for (const mon of this.save.party) healMon(this.data, mon);
  }

  /** Music.lua:383 playOnce / :407 restoreMap, for the script verbs. */
  playOnce(song: string): void {
    this.audio.playOnce(song);
  }

  restoreMapMusic(): void {
    this.audio.restore();
  }

  /** Music.lua:339 playMap, from the site that owns the moment. */
  startMapMusic(mapId: string): void {
    this.audioMap = mapId;
    this.audio.startMap(mapId);
  }

  showText(text: string, onDone?: () => void): void {
    this.push(new TextBoxState(this, text, onDone));
  }

  showChoice(text: string, choice: (yes: boolean) => void): void {
    this.showMenuChoice(text, ["YES", "NO"], (index) => choice(index === 0));
  }

  /** A native GB dialogue with caller-owned labels (the PC uses LOCAL/REMOTE). */
  showMenuChoice(text: string, labels: readonly string[], choice: (index: number) => void): void {
    this.push(new TextBoxState(this, text, undefined, { labels, choose: choice }));
  }

  /**
   * OpenRedsPC replacement for this runtime's bedroom: choose a data source in
   * the game's native dialogue first, then mount either shell as a modal
   * state. The remote state retries its host stream in place and never falls
   * back to local when no daemon is online.
   */
  openBedroomComputer(): void {
    this.audio.playSfx("Turn_On_PC");
    this.showMenuChoice("Which PC do you\nwant to open?", ["LOCAL PC", "REMOTE PC"], (index) => {
      this.audio.playSfx("Enter_PC");
      if (index === 0) {
        this.push(new PcDesktopState(this));
        return;
      }
      this.push(new RemotePcState(this));
    });
  }

  openStartMenu(): void {
    this.push(new StartMenuState(this));
  }

  pushWarpFade(frames: number, midpoint: () => void, onDone?: () => void): void {
    this.push(new WarpFadeState(this, frames, midpoint, onDone));
  }

  /**
   * Evolution.lua:195-223 checkParty driving :156-178 evolve, one mon at a
   * time in party order. The Lua plays EvolutionState's flashing-forms movie
   * when it has graphics and falls back to the plain text flow otherwise;
   * this slice takes the fallback — the same two pages, the same apply, and
   * the evolved species' exact-level learn check afterwards (:174, the
   * evos_moves.asm EvolveMon -> LearnMoveFromLevelUp predef).
   */
  runEvolutions(leveledUp: ReadonlySet<PartyMon> | null | undefined): void {
    const pending = checkParty(this.data, this.save.party, leveledUp);
    if (pending.length === 0) return;
    const step = (i: number): void => {
      const row = pending[i];
      if (!row) return;
      const { mon, to } = row;
      const oldName = mon.nickname ?? this.data.pokemon[mon.species]!.name;
      const newName = this.data.pokemon[to]!.name;
      applyEvolution(this.data, mon, to);
      this.showText(
        `What?\n${oldName} is\nevolving!\fCongratulations!\nYour ${oldName}\nevolved into\n${newName}!`,
        () => {
          this.learnEvolutionMoves(mon, () => step(i + 1));
        },
      );
    };
    step(0);
  }

  /**
   * Evolution.lua:112-152 learnEvolutionMoves — the EVOLVED species' learnset
   * at exactly this level (movesLearnedAt, not movesAtLevel), each new move
   * announced on its own page. A full moveset keeps battle.ts's v1 deviation:
   * MoveLearnMenu is not in this slice, so the mon declines and says so.
   */
  private learnEvolutionMoves(mon: PartyMon, onDone: () => void): void {
    const def = this.data.pokemon[mon.species]!;
    const learned = movesLearnedAt(def, mon.level);
    const name = mon.nickname ?? def.name;
    const step = (i: number): void => {
      const moveId = learned[i];
      if (!moveId) {
        onDone();
        return;
      }
      const mdef = this.data.moves[moveId];
      if (!mdef || mon.moves.some((mv) => mv.id === moveId)) {
        step(i + 1);
        return;
      }
      if (mon.moves.length < 4) {
        mon.moves.push({ id: moveId, pp: mdef.pp });
        this.showText(`${name} learned\n${mdef.name}!`, () => step(i + 1));
        return;
      }
      this.showText(
        `${name} is trying to\nlearn ${mdef.name}!\f${name} did not learn\n${mdef.name}!`,
        () => step(i + 1),
      );
    };
    step(0);
  }

  // OverworldShell keeps the seam's method name (overworld.ts is another
  // task's file); since the battle port it constructs the REAL wild battle
  // (BattleState.newWild in the reference).
  pushStubBattle(species: string, level: number): void {
    this.push(new BattleGameState(this, species, level));
  }

  pushTrainerBattle(
    name: string,
    trainerClass: string,
    party: readonly { species: string; level: number }[],
    onWin: () => void,
  ): void {
    const first = party[0];
    if (!first) { onWin(); return; }
    this.push(new BattleGameState(this, first.species, first.level, { name, trainerClass, party, onWin }));
  }

  /** BeatTrainer payout: final enemy level × the ROM trainer-class rate. */
  awardTrainerMoney(
    name: string,
    trainerClass: string,
    party: readonly { level: number }[],
    onDone?: () => void,
  ): number {
    const prize = trainerPayout(this.data.trainers?.[trainerClass], party);
    this.save.money = Math.min(MAX_MONEY, (this.save.money ?? 0) + prize);
    if (prize > 0) {
      this.showText(`${this.save.player.name} got ¥${prize}\nfor winning!`, onDone);
    } else {
      onDone?.();
    }
    return prize;
  }

  openMart(stock: readonly { item: string; price: number }[]): void {
    this.showMenuChoice(`Welcome! You have\n¥${this.save.money ?? 0}.`, ["BUY", "SELL", "QUIT"], (mode) => {
      if (mode === 0) this.openMartBuy(stock);
      else if (mode === 1) this.openMartSell();
    });
  }

  private openMartBuy(stock: readonly { item: string; price: number }[]): void {
    const labels = stock.map((row) => {
      const name = this.data.items?.[row.item]?.name ?? row.item.replaceAll("_", " ");
      return `${name} ¥${row.price}`;
    });
    this.showMenuChoice(`You have ¥${this.save.money ?? 0}.\nWhat would you like?`, [...labels, "CANCEL"], (index) => {
      const row = stock[index];
      if (!row) return;
      if ((this.save.money ?? 0) < row.price) {
        this.showText("You don't have\nenough money.");
        return;
      }
      if (!Bag.add(this.save, row.item, 1, this.data)) {
        this.showText("You can't carry\nany more items!");
        return;
      }
      this.save.money = (this.save.money ?? 0) - row.price;
      const name = this.data.items?.[row.item]?.name ?? row.item.replaceAll("_", " ");
      this.showText(`Here you are!\nYou bought ${name}!`);
    });
  }

  private openMartSell(): void {
    const ids = Bag.order(this.save).filter((id) => {
      const def = this.data.items?.[id];
      return (this.save.inventory[id] ?? 0) > 0 && !!def && !def.keyItem && sellPrice(def) > 0;
    });
    if (ids.length === 0) {
      this.showText("You have nothing\nI can buy.");
      return;
    }
    const labels = ids.map((id) => {
      const def = this.data.items![id]!;
      return `${def.name} x${this.save.inventory[id]} ¥${sellPrice(def)}`;
    });
    this.showMenuChoice("What would you\nlike to sell?", [...labels, "CANCEL"], (index) => {
      const id = ids[index];
      if (!id) return;
      const def = this.data.items![id]!;
      const value = sellPrice(def);
      Bag.remove(this.save, id, 1);
      this.save.money = Math.min(MAX_MONEY, (this.save.money ?? 0) + value);
      this.showText(`${def.name} sold\nfor ¥${value}.`);
    });
  }

  /** Start-menu POKEMON: choose a party member, then its destination slot. */
  openParty(): void {
    if (this.save.party.length === 0) {
      this.showText("You have no POKéMON!");
      return;
    }
    const labels = () => this.save.party.map((mon, i) => {
      const name = mon.nickname ?? this.data.pokemon[mon.species]?.name ?? mon.species;
      return `${i + 1} ${name} L${mon.level}`;
    });
    this.showMenuChoice("Choose a POKéMON.", [...labels(), "CANCEL"], (from) => {
      if (!this.save.party[from]) return;
      this.showMenuChoice("Move it to which\nposition?", [...labels(), "CANCEL"], (to) => {
        if (!this.save.party[to]) return;
        if (from !== to) {
          const mon = this.save.party[from];
          this.save.party[from] = this.save.party[to];
          this.save.party[to] = mon;
        }
        const lead = this.save.party[0];
        const name = lead.nickname ?? this.data.pokemon[lead.species]?.name ?? lead.species;
        this.showText(`${name} is now\nfirst in the lineup.`);
      });
    });
  }

  private teachMachine(id: string, partyIndex: number): void {
    const item = this.data.items?.[id];
    const machine = item?.machine;
    const mon = this.save.party[partyIndex];
    if (!machine || !mon) return;
    const species = this.data.pokemon[mon.species];
    const monName = mon.nickname ?? species?.name ?? mon.species;
    const moveName = this.data.moves[machine.move]?.name ?? machine.move.replaceAll("_", " ");
    if (!species?.tmhm.includes(machine.move)) {
      this.showText(`${monName} is not\ncompatible with ${item.name}.`);
      return;
    }
    if (mon.moves.some((move) => move.id === machine.move)) {
      this.showText(`${monName} already\nknows ${moveName}.`);
      return;
    }
    const finish = () => {
      mon.moves.push({ id: machine.move, pp: this.data.moves[machine.move]?.pp ?? 0 });
      if (machine.kind === "TM") Bag.remove(this.save, id, 1);
      this.showText(`${monName} learned\n${moveName}!`);
    };
    if (mon.moves.length < 4) {
      finish();
      return;
    }
    const moveLabels = mon.moves.map((move) => this.data.moves[move.id]?.name ?? move.id.replaceAll("_", " "));
    this.showMenuChoice(`Forget which move\nfor ${moveName}?`, [...moveLabels, "CANCEL"], (moveIndex) => {
      const old = mon.moves[moveIndex];
      if (!old) return;
      const oldMachine = Object.values(this.data.items ?? {}).find((def) =>
        def.machine?.kind === "HM" && def.machine.move === old.id
      );
      if (oldMachine) {
        this.showText("HM moves can't be\nforgotten!");
        return;
      }
      mon.moves.splice(moveIndex, 1);
      finish();
    });
  }

  openBag(): void {
    const ids = Bag.order(this.save).filter((id) =>
      (this.save.inventory[id] ?? 0) > 0 && !id.includes("BADGE"),
    );
    if (ids.length === 0) { this.showText("The BAG is empty."); return; }
    this.showMenuChoice("Which item?", [...ids.map((id) => {
      const def = this.data.items?.[id];
      const name = def?.name ?? id.replaceAll("_", " ");
      const move = def?.machine && (this.data.moves[def.machine.move]?.name ?? def.machine.move.replaceAll("_", " "));
      return `${name}${move ? ` ${move}` : ""} x${this.save.inventory[id]}`;
    }), "CANCEL"], (itemIndex) => {
      const id = ids[itemIndex];
      if (!id) return;
      const targets = this.save.party.map((mon) => mon.nickname ?? this.data.pokemon[mon.species]?.name ?? mon.species);
      this.showMenuChoice("Use on which\nPOKéMON?", [...targets, "CANCEL"], (partyIndex) => {
        const mon = this.save.party[partyIndex];
        if (!mon) return;
        if (this.data.items?.[id]?.machine) {
          this.teachMachine(id, partyIndex);
          return;
        }
        let used = false;
        if (id === "POTION" && mon.hp > 0 && mon.hp < mon.stats.hp) {
          mon.hp = Math.min(mon.stats.hp, mon.hp + 20);
          used = true;
        } else if (id === "ANTIDOTE" && mon.status === "PSN") {
          mon.status = null; used = true;
        } else if (id === "PARLYZ_HEAL" && mon.status === "PAR") {
          mon.status = null; used = true;
        } else if (id === "BURN_HEAL" && mon.status === "BRN") {
          mon.status = null; used = true;
        } else if (id === "AWAKENING" && mon.status === "SLP") {
          mon.status = null; used = true;
        }
        if (!used) { this.showText("It won't have any\neffect."); return; }
        this.save.inventory[id] -= 1;
        if (this.save.inventory[id] <= 0) delete this.save.inventory[id];
        this.showText(`${targets[partyIndex]} recovered!`);
      });
    });
  }

  // SceneView -----------------------------------------------------------

  uiBox(): UiBoxSource | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i] as GameState & Partial<UiBoxSource>;
      if (s.box) return s as GameState & UiBoxSource;
    }
    return null;
  }

  uiChoice(): ChoiceSource | null {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "choice" ? (top as ChoiceState) : null;
  }

  pcDesktop(): PcDesktopSource | null {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "pc-desktop" ? (top as PcDesktopState) : null;
  }

  remotePc(): RemotePcSource | null {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "pc-remote" ? (top as RemotePcState) : null;
  }

  systemOverlay(): SystemOverlaySource | null {
    const top = this.stack[this.stack.length - 1];
    return top?.kind === "title" || top?.kind === "start-menu"
      ? (top as TitleState | StartMenuState)
      : null;
  }

  battleView(): BattleSceneView | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i];
      if (s.kind === "battle") return s as BattleGameState;
    }
    return null;
  }
}
