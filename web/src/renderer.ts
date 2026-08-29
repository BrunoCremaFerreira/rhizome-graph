/**
 * WebGL drawing layer (three.js). Reads the pure {@link Simulation} model and
 * the {@link ForceLayout} positions each frame and paints the Gource look:
 * a black field, thin directory edges, glowing colored file dots, directory
 * labels, and per-agent actors that fire animated beams at the files they touch.
 *
 * This layer owns NO domain state -- it renders what the model says and plays
 * transient visual effects (beams, flashes) on top. The hot path allocates
 * nothing in steady state; buffers are rebuilt only when the tree's topology
 * changes.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  LinearFilter,
  LineBasicMaterial,
  LineSegments,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { APP_NAME } from "./branding";
import type { AgentEvent } from "./protocol";
import type { SimNode, Simulation } from "./simulation";
import { ForceLayout } from "./layout";
import { createAvatarCanvas } from "./avatar";
import { NEUTRAL_NODE_COLOR, actorColor, fileColor, hexToInt } from "./colors";
import { UNMEASURED_COLOR } from "./sizeColor";
import {
  allocateEdgeAttributes,
  allocateNodeAttributes,
  createEdgeGeometry,
  createNodeGeometry,
} from "./geometry";
import {
  createView,
  focusOn,
  follow,
  panByPixels,
  releaseToAuto,
  zoomAt,
  type ViewState,
} from "./view";
import { frameMatches, type SearchFrame } from "./search";
import { createSearchMarkerCanvas } from "./searchMarker";
import { createReadMarkerCanvas } from "./readMarker";
import { createAlarmMarkerCanvas } from "./alarmMarker";
// The idle fade and its two exemptions live in a pure module: a condition
// written into the per-frame loop below would carry no test at all.
import { nodeOpacityFactor } from "./nodeFade";
// The two beam lifetimes live in a pure module because a constant declared
// here cannot be imported by a test: `agentState.ts`'s DEPARTURE_SECONDS has
// to outlive the longest beam, and that relation is asserted in vitest.
import { BEAM_LIFE_SECONDS, READ_BEAM_LIFE_SECONDS } from "./beams";
import { createWaitMarkerCanvas } from "./waitMarker";
import {
  createAgentStates,
  departedAgents,
  waitingAgents,
  DEPARTURE_SECONDS,
  type AgentStateModel,
} from "./agentState";
import {
  pickFile,
  hoverTarget,
  isClickGesture,
  type PickCandidate,
  type ClickGesture,
} from "./pick";
import {
  fileLabelOpacity,
  labelFontPixels,
  labelOffset,
  labelWorldHeight,
  selectFileLabels,
  snapToPixelGrid,
  spriteHeightForEm,
  actorDisplayName,
  MAX_FILE_LABELS,
  type LabelCandidate,
} from "./labels";

/** A transient animated line from an actor to a file it just touched. */
interface Beam {
  actor: string;
  target: string;
  color: number;
  age: number;
  life: number;
}

/** Eased on-screen position, figure and label for an agent. */
interface ActorView {
  agent: string;
  color: number;
  x: number;
  y: number;
  hasPos: boolean;
  /** The Gource-style figure that walks the tree. */
  figure: Sprite;
  label: Sprite;
  /** Caption currently painted on `label`, so it is repainted only on change. */
  labelText: string;
  /**
   * The broken ring worn while this agent is blocked, built on first need.
   *
   * One sprite per actor rather than a shared pool, because the ring carries
   * the ACTOR's own colour — two waiting agents cannot share a texture. Bounded
   * by the actor map, which the departure below is the first mechanism ever to
   * shrink.
   */
  waitRing: Sprite | null;
}

/**
 * One reusable file-name sprite.
 *
 * The pool is fixed at {@link MAX_FILE_LABELS}; slots are handed to whichever
 * files {@link selectFileLabels} picks this frame. Retexturing only when `path`
 * changes is what keeps a canvas out of the per-frame path.
 */
interface FileLabelSlot {
  sprite: Sprite;
  /** Path currently drawn, or `""` when the slot is parked. */
  path: string;
}

/**
 * One reusable violet ring for a file being read.
 *
 * Pooled like {@link FileLabelSlot}, and the slot stays with its path while the
 * file is still being read. Every sprite shares ONE texture (the rings are the
 * same shape in the same colour), so a slot changing hands costs a position and
 * a scale, never a canvas.
 */
interface ReadMarkerSlot {
  sprite: Sprite;
  /** Path currently ringed, or `""` when the slot is parked. */
  path: string;
}

/** What one file being read needs for its ring: where it is, and how strongly. */
interface ReadCandidate {
  path: string;
  reading: number;
  x: number;
  y: number;
}

/**
 * One reusable bracket for a file an attention rule fired on.
 *
 * Pooled exactly like {@link ReadMarkerSlot}, slot bound to its path, one
 * shared texture. The one difference is that it does NOT fade: a read decays
 * and its ring shrinks with it, while an alarm lasts until a human dismisses
 * it, so there is no channel to sort a full pool by and the oldest alarms
 * simply keep the slots they hold.
 */
interface AlarmMarkerSlot {
  sprite: Sprite;
  /** Path currently bracketed, or `""` when the slot is parked. */
  path: string;
}

const MAX_BEAMS = 512;
/** The neutral grey a directory dot wears, shared with the size mode's unmeasured nodes. */
const DIR_COLOR = NEUTRAL_NODE_COLOR;

/**
 * Colour of a file being read, the violet the daemon puts on the wire (AA66FF).
 *
 * It is a hue no operation owns — `A` is green, `M` orange, `D` red, a match
 * cyan and a directory grey — because a read must never be mistaken for a change
 * to the file it lands on.
 */
const READ_COLOR = 0xaa66ff;
/** How far a fully-read file's dot is dragged toward {@link READ_COLOR}. */
const READ_TINT = 0.75;
/** Extra point size, in device pixels, at `reading === 1`. */
const READ_SIZE_BOOST = 4;
/**
 * How many read rings can be on screen at once.
 *
 * Bounded like the file-label pool, and for the same reason: a real project has
 * hundreds of files and an agent can read dozens of them in a second, so a
 * sprite per node is not an option. Slots stay bound to their path while the
 * file is still being read, so a new read does not shuffle every ring.
 */
const MAX_READ_MARKERS = 24;
/** Diameter of a read ring at `reading === 1`, in DEVICE pixels. */
const READ_MARKER_PIXELS = 34;
/** Radians per second of the read ring's pulse, and its depth. */
const READ_PULSE_RATE = 4;
const READ_PULSE_DEPTH = 0.22;
/** Below this, the ring is not worth a slot another file could use. */
const READ_MARKER_MIN = 0.02;
/**
 * How many alarm brackets can be on screen at once.
 *
 * Bounded like every other pool here. Half the read pool on purpose: alarms are
 * meant to be rare, the panel lists what the graph cannot show, and a screen of
 * brackets would say only that the rule file is too broad.
 */
const MAX_ALARM_MARKERS = 12;
/** Side of an alarm bracket, in DEVICE pixels. Larger than the read ring: it
 * has to be found by eye rather than noticed on a node already being looked at. */
const ALARM_MARKER_PIXELS = 44;
/**
 * Colour of the alarm bracket: the red `D` already speaks on this page.
 *
 * Deliberately NOT a sixth semantic colour. The shape is what says "alarm" --
 * two facing brackets against the read marker's rings and the search marker's
 * one -- and the hue only has to read as "look at this", which the delete red
 * already does. A bracket is never drawn on the same node a delete flash is
 * fading on for long: the node is gone from the tree moments later.
 */
const ALARM_MARKER_COLOR = 0xff3333;
/** Height of the agent figure in world units (a file dot is a few px wide). */
const AVATAR_WORLD_HEIGHT = 7;
/**
 * The layout's pinned centre, where an agent that has done nothing yet stands.
 *
 * `layout.ts:24` spells it, and `sync` always keeps it live, so `position("")`
 * always answers. An agent blocked on a permission prompt for its FIRST tool
 * call has fired no `PostToolUse`, so it has no file to be placed on — and an
 * actor with no position is hidden outright, which would leave the highest
 * value half of the wait marker with nothing to paint on.
 */
const LAYOUT_ROOT_ID = "";
/** Diameter of an agent's wait ring, in DEVICE pixels. */
const WAIT_MARKER_PIXELS = 46;
/** Radians per second of the wait ring's pulse, and its depth. */
const WAIT_PULSE_RATE = 3;
const WAIT_PULSE_DEPTH = 0.12;

/**
 * Colour of a node the search matched.
 *
 * Cyan is the one hue left free: `A` is green, `M` orange, `D` red and a
 * directory grey, so a match cannot be mistaken for a file that merely happens
 * to have just been written.
 */
const SEARCH_COLOR = 0x00e5ff;
/** Extra point size, in device pixels, given to any match. */
const SEARCH_SIZE_BOOST = 4;
/** Extra point size, in device pixels, given to the one match F3 is on. */
const SEARCH_ACTIVE_SIZE_BOOST = 8;
/** Radians per second of the active match's pulse, and its depth. */
const SEARCH_PULSE_RATE = 6;
const SEARCH_PULSE_DEPTH = 0.18;
/**
 * Diameter of the active-match ring, in DEVICE pixels.
 *
 * In pixels, not world units, for the reason labels.ts documents: the camera
 * spans halfHeight 2..4000, so anything sized in world units is either
 * sub-pixel with the tree framed or covers the screen up close.
 */
const SEARCH_MARKER_PIXELS = 44;
/** How fast the camera eases onto what the search asked it to show. */
const SEARCH_FOCUS_EASE = 0.12;

/**
 * How near a file dot a click must land, in DEVICE pixels.
 *
 * In pixels, like {@link SEARCH_MARKER_PIXELS} and for the same reason: with the
 * camera spanning halfHeight 2..4000 a world-unit radius would select nothing
 * with the tree framed and half the project up close.
 */
const PICK_RADIUS_PIXELS = 14;

/** Per-point shader: per-vertex size (px) + color, soft circular alpha. */
const POINT_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize;
  }
`;
const POINT_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    float alpha = smoothstep(1.0, 0.15, r);
    if (alpha <= 0.01) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

/** What the page wants to hear about, beyond drawing. */
export interface RendererOptions {
  /**
   * A click that landed on a file node, by path.
   *
   * The renderer reports the hit and nothing more: what a click on a file MEANS
   * -- ask the daemon, open a panel -- belongs to `main.ts`, and this layer has
   * no idea a panel exists.
   */
  readonly onFileClick?: (path: string) => void;
}

export class GourceRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  /**
   * Text, drawn after the composer and outside the bloom.
   *
   * Every glyph pixel is above the bloom's threshold, so a label left in the
   * main scene gets an additive halo that closes the counters of its letters --
   * exactly the shapes that make it legible. The tree glows; its captions do not.
   */
  private readonly overlayScene = new Scene();
  private readonly camera: OrthographicCamera;
  private readonly composer: EffectComposer;
  private readonly layout = new ForceLayout();

  private readonly nodePoints: Points;
  // Allocated empty (not bare) so the first frame -- which runs before any
  // event arrives, and therefore triggers no rebuild -- still finds attributes.
  private readonly nodeGeom = createNodeGeometry(0);
  private readonly edges: LineSegments;
  private readonly edgeGeom = createEdgeGeometry(0);
  private readonly beamLines: LineSegments;
  private readonly beamGeom = new BufferGeometry();
  private dragPointer: number | null = null;
  private dragX = 0;
  private dragY = 0;
  /** Where and when the press started, kept apart from the drag's last position. */
  private downX = 0;
  private downY = 0;
  private downTime = 0;
  /**
   * Where the mouse is resting, in CSS pixels, or null when it is not on the
   * canvas. Recorded on every move (drag or not) because the answer to "what is
   * under it" is recomputed each frame, not on the event.
   */
  private hoverX = 0;
  private hoverY = 0;
  private hoverActive = false;
  /** The file under the pointer this frame, as decided by `hoverTarget`. */
  private hoveredPath: string | null = null;
  /**
   * Scratch for the pointer→world conversion, refilled in place: the hover runs
   * every frame, and the click and the hover never hold it at the same time.
   */
  private readonly ndcScratch = { x: 0, y: 0 };
  private readonly worldScratch = { x: 0, y: 0 };
  private readonly reportedFrameErrors = new Set<string>();
  private readonly beamPos = new Float32Array(MAX_BEAMS * 2 * 3);
  private readonly beamColor = new Float32Array(MAX_BEAMS * 2 * 3);

  private readonly nodeIndex = new Map<string, number>();
  private nodeIds: string[] = [];
  private edgeChild: string[] = [];
  private edgeParent: string[] = [];

  private readonly actors = new Map<string, ActorView>();
  private readonly dirLabels = new Map<string, Sprite>();
  private readonly fileLabels: FileLabelSlot[] = [];
  // Reused across frames and refilled in place: one object per file per frame
  // would be hundreds of allocations a second on a real project.
  private readonly labelCandidates: LabelCandidate[] = [];
  /** Scratch for the slot assignment below; cleared and refilled each frame. */
  private readonly chosenByPath = new Map<string, LabelCandidate>();
  /** The violet rings, and the two scratch containers that hand them out. */
  private readonly readMarkers: ReadMarkerSlot[] = [];
  private readonly readCandidates: ReadCandidate[] = [];
  private readonly readByPath = new Map<string, ReadCandidate>();
  /** The alarm brackets, and the scratch set that hands them out each frame. */
  private readonly alarmMarkers: AlarmMarkerSlot[] = [];
  private readonly alarmPending = new Set<string>();
  private readonly beams: Beam[] = [];

  /**
   * What the search box is currently pointing at. Held as a Set because
   * `updateNodeAttributes` asks "is this one a match?" once per node per frame.
   * The renderer owns no domain state: this is a copy of what `main.ts` handed
   * it, kept only so each frame can paint it.
   */
  private readonly searchMatches = new Set<string>();
  private searchActivePath: string | null = null;
  private searchFrame: SearchFrame = "all";
  /**
   * Whether the camera is still obeying the search.
   *
   * A wheel or a drag disarms it -- the user is looking around and must not be
   * dragged back -- without clearing the highlights, which are still the answer
   * to their question. The next `setSearch` (a new query, or F3) rearms.
   */
  private searchArmed = false;
  /**
   * The file the viewer panel is open on, or null.
   *
   * No domain state either: `main.ts` owns the panel and hands this down so the
   * frame can mark which dot the text on screen belongs to.
   */
  private openFilePath: string | null = null;
  /**
   * Fraction of the canvas width hidden behind a panel on the right, `0` when
   * nothing is. Measured and pushed in by the panel's owner; see
   * {@link setOccludedRight}.
   */
  private occludedRight = 0;
  /**
   * Path -> packed `0xRRGGBB` while the size mode is armed, null while it is not.
   *
   * A MAP OF ANSWERS, like `setSearch`'s list of paths: nothing here learns what
   * a byte is, what a median is, or which key armed the mode. Every percentile
   * and every ramp evaluation happened once, when the measurement was adopted.
   */
  private sizeColors: ReadonlyMap<string, number> | null = null;
  /**
   * The paths an attention rule fired on and nobody has dismissed yet.
   *
   * A SET OF ANSWERS, like `setSearch`'s matches and `setSizeColors`'s map:
   * nothing in here learns that a rule file exists, what a pattern is, or which
   * click cleared a row. The verdict was reached in the daemon and the latch
   * belongs to `attentionState.ts`, where both carry tests.
   */
  private alarmedPaths: ReadonlySet<string> = new Set<string>();
  /**
   * The daemon's picture of its own actors, as `agentState.ts` holds it.
   *
   * An ANSWER, like `sizeColors`: nothing here learns what a `Notification` is,
   * what a `Stop` is, or that hooks exist. The two selectors are asked EVERY
   * FRAME rather than once on adoption, because both are functions of `now` —
   * a wait goes stale and a departure completes while no frame arrives at all.
   */
  private agentStates: AgentStateModel = createAgentStates();
  /** Scratch for the two per-frame selector answers; cleared, never realloced. */
  private readonly waitingNow = new Set<string>();
  private readonly departingNow = new Set<string>();
  /** The active match's ring, in the MAIN scene: unlike text, it should glow. */
  private readonly searchMarker: Sprite;
  /** Scratch for the camera frame; refilled in place, never reallocated. */
  private readonly framePoints: { x: number; y: number }[] = [];

  private view: ViewState = createView(60);
  private lastTime = 0;
  /** Seconds since start, for effects that pulse. */
  private elapsed = 0;
  private running = false;
  private readonly scratchColor = new Color();

  /**
   * Font size labels are rasterised at, in device pixels, and the anisotropy
   * they are sampled with. Both are fixed for the life of the context: a label
   * is always {@link LABEL_PIXEL_HEIGHT} CSS pixels tall on screen, so the only
   * thing deciding how many real pixels that is, is the device pixel ratio.
   */
  private readonly labelFont: number;
  private readonly labelAnisotropy: number;
  /** Per-frame label metrics, reused in place so the hot path allocates nothing. */
  private readonly labelMetrics = { em: 0, offset: 0, worldPerPixel: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sim: Simulation,
    private readonly options: RendererOptions = {},
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.scene.background = new Color(0x000000);

    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const half = this.view.halfHeight;
    this.camera = new OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, 1000);
    this.camera.position.set(0, 0, 100);

    const pointMaterial = new ShaderMaterial({
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.nodePoints = new Points(this.nodeGeom, pointMaterial);
    this.nodePoints.frustumCulled = false;
    this.scene.add(this.nodePoints);

    this.edges = new LineSegments(
      this.edgeGeom,
      new LineBasicMaterial({ color: DIR_COLOR, transparent: true, opacity: 0.25, depthTest: false }),
    );
    this.edges.frustumCulled = false;
    this.scene.add(this.edges);

    this.beamGeom.setAttribute("position", new BufferAttribute(this.beamPos, 3));
    // LineBasicMaterial reads per-vertex color from the "color" attribute.
    this.beamGeom.setAttribute("color", new BufferAttribute(this.beamColor, 3));
    this.beamLines = new LineSegments(
      this.beamGeom,
      new LineBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthTest: false, opacity: 0.9 }),
    );
    this.beamLines.frustumCulled = false;
    this.scene.add(this.beamLines);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(
      new UnrealBloomPass(new Vector2(canvas.clientWidth, canvas.clientHeight), 1.1, 0.6, 0.05),
    );
    this.composer.addPass(new OutputPass());

    // The renderer clamps the pixel ratio, so this -- not window.devicePixelRatio
    // -- is how many real pixels a CSS pixel of label actually covers.
    this.labelFont = labelFontPixels(this.renderer.getPixelRatio());
    this.labelAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    for (let i = 0; i < MAX_FILE_LABELS; i += 1) {
      const sprite = new Sprite(
        new SpriteMaterial({ transparent: true, depthTest: false, opacity: 0 }),
      );
      sprite.visible = false;
      sprite.userData.aspect = 1;
      sprite.userData.emFraction = 1;
      this.overlayScene.add(sprite);
      this.fileLabels.push({ sprite, path: "" });
    }

    this.searchMarker = makeSearchMarker();
    this.searchMarker.visible = false;
    // Main scene, not `overlayScene`: the ring is meant to bloom.
    this.scene.add(this.searchMarker);

    // One texture for the whole pool; the sprites differ only in where they sit,
    // how big they are and how bright. Main scene as well: unlike text, a glow
    // through the bloom is exactly what a read should look like.
    const readTexture = makeReadMarkerTexture();
    for (let i = 0; i < MAX_READ_MARKERS; i += 1) {
      const sprite = new Sprite(
        new SpriteMaterial({ map: readTexture, transparent: true, depthTest: false, opacity: 0 }),
      );
      sprite.visible = false;
      this.scene.add(sprite);
      this.readMarkers.push({ sprite, path: "" });
    }

    // Same again for the alarm brackets: one texture for the whole pool, in the
    // MAIN scene, because unlike text a glow through the bloom is exactly what
    // a marker wanting to be found across a framed-whole tree should have.
    const alarmTexture = makeAlarmMarkerTexture();
    for (let i = 0; i < MAX_ALARM_MARKERS; i += 1) {
      const sprite = new Sprite(
        new SpriteMaterial({ map: alarmTexture, transparent: true, depthTest: false, opacity: 0 }),
      );
      sprite.visible = false;
      this.scene.add(sprite);
      this.alarmMarkers.push({ sprite, path: "" });
    }

    this.bindInput();
    this.resize();
  }

  /**
   * Wheel to zoom under the cursor, drag to pan, double-click to resume
   * auto-fit. Without this the camera reframes the whole graph every frame and
   * labels are unreadable as soon as the tree grows.
   */
  private bindInput(): void {
    this.canvas.addEventListener(
      "wheel",
      (event: WheelEvent) => {
        event.preventDefault();
        // One notch ~= 10%; trackpads send many small deltas, so scale by size.
        const factor = Math.exp(event.deltaY * 0.0015);
        // Touching the camera takes it back from the search, highlights and all
        // still showing.
        this.searchArmed = false;
        this.view = zoomAt(this.view, factor, this.pointerNdc(event.clientX, event.clientY), this.aspect());
        this.syncCamera();
      },
      { passive: false },
    );

    this.canvas.addEventListener("pointerdown", (event: PointerEvent) => {
      this.dragPointer = event.pointerId;
      this.dragX = event.clientX;
      this.dragY = event.clientY;
      // Kept separately from the drag position, which every `pointermove`
      // overwrites: telling a click from a pan needs the ORIGIN of the gesture.
      this.downX = event.clientX;
      this.downY = event.clientY;
      this.downTime = performance.now();
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = "grabbing";
    });

    this.canvas.addEventListener("pointermove", (event: PointerEvent) => {
      // Recorded BEFORE the drag test: a pointer that is merely passing over the
      // canvas never reaches the code below, and its position is exactly what
      // the hover needs. Touch is excluded because there is no hover on a
      // touchscreen -- a finger that lifts would leave a name stuck to the last
      // place it landed.
      if (event.pointerType === "mouse") {
        this.hoverX = event.clientX;
        this.hoverY = event.clientY;
        this.hoverActive = true;
      }

      if (this.dragPointer !== event.pointerId) return;
      const dx = event.clientX - this.dragX;
      const dy = event.clientY - this.dragY;
      this.dragX = event.clientX;
      this.dragY = event.clientY;
      this.searchArmed = false;
      this.view = panByPixels(this.view, dx, dy, {
        width: this.canvas.clientWidth || window.innerWidth,
        height: this.canvas.clientHeight || window.innerHeight,
      });
      this.syncCamera();
    });

    const endDrag = (event: PointerEvent): void => {
      if (this.dragPointer !== event.pointerId) return;
      this.dragPointer = null;
      this.canvas.style.cursor = "grab";
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    };
    this.canvas.addEventListener("pointerup", (event: PointerEvent) => {
      // Only a release that ends the gesture this canvas is tracking can be a
      // click, and only after the drag has been closed out.
      const ours = this.dragPointer === event.pointerId;
      endDrag(event);
      if (ours) this.handleClick(event);
    });
    // A cancelled pointer (the browser took it for a gesture of its own) ends
    // the pan and opens nothing.
    this.canvas.addEventListener("pointercancel", endDrag);

    // The pointer left: forget where it was, or the last node it happened to
    // cross keeps its name for as long as the page stays open.
    const clearHover = (): void => {
      this.hoverActive = false;
    };
    this.canvas.addEventListener("pointerleave", clearHover);
    this.canvas.addEventListener("pointerout", clearHover);
    this.canvas.addEventListener("pointercancel", clearHover);

    this.canvas.addEventListener("dblclick", () => {
      this.view = releaseToAuto(this.view);
    });

    this.canvas.style.cursor = "grab";
  }

  /**
   * Pointer position in normalized device coordinates (y up).
   *
   * Takes CSS coordinates rather than an event because the hover is resolved on
   * a frame, long after the event that recorded the position is gone. `out`
   * lets the per-frame caller pass its own scratch and allocate nothing.
   */
  private pointerNdc(clientX: number, clientY: number, out = { x: 0, y: 0 }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    out.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    out.y = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    return out;
  }

  /**
   * Pointer position in WORLD units, by the same path `zoomAt` takes -- so what
   * a click opens, what the wheel zooms towards and what the hover names are all
   * the same node. One implementation, because two would drift apart.
   */
  private pointerWorld(
    clientX: number,
    clientY: number,
    out: { x: number; y: number },
  ): { x: number; y: number } {
    const ndc = this.pointerNdc(clientX, clientY, this.ndcScratch);
    out.x = this.view.centerX + ndc.x * this.view.halfHeight * this.aspect();
    out.y = this.view.centerY + ndc.y * this.view.halfHeight;
    return out;
  }

  /**
   * A press and release in the same place: report the file under it, if any.
   *
   * Everything decided here is either a threshold or a coordinate change; WHICH
   * node wins is `pickFile`'s, in a pure module with tests, because this class
   * needs a GL context and none can reach it.
   */
  private handleClick(event: PointerEvent): void {
    const onFileClick = this.options.onFileClick;
    if (!onFileClick) return;
    // Whether this gesture is a click at all is `isClickGesture`'s, next to
    // `pickFile` and for the same reason: it is a decision, and no decision is
    // testable in here.
    const gesture: ClickGesture = {
      detail: event.detail,
      dx: event.clientX - this.downX,
      dy: event.clientY - this.downY,
      elapsedMs: performance.now() - this.downTime,
    };
    if (!isClickGesture(gesture)) return;

    const world = this.pointerWorld(event.clientX, event.clientY, this.worldScratch);

    // Directories are left out: the panel shows file contents, and a click on a
    // folder does nothing rather than opening its nearest child by accident.
    const candidates: PickCandidate[] = [];
    for (const node of this.sim.listNodes()) {
      if (node.kind !== "file") continue;
      const p = this.layout.position(node.path);
      if (!p) continue;
      candidates.push({ path: node.path, x: p.x, y: p.y });
    }

    const hit = pickFile(
      candidates,
      world,
      this.labelMetrics.worldPerPixel * PICK_RADIUS_PIXELS,
    );
    if (hit) onFileClick(hit);
  }

  /**
   * Mark the file whose contents are on screen, or clear the mark with null.
   *
   * It wears the search's active highlight so there is no doubt which dot the
   * panel is about — the two never disagree, because the ring goes to the open
   * file while there is one.
   */
  setOpenFile(path: string | null): void {
    this.openFilePath = path;
  }

  /**
   * How much of the viewport's width is covered on the right by a panel.
   *
   * A MEASUREMENT, taken by whoever owns that panel and handed here as a
   * fraction of the canvas width — never the stylesheet's own `40vw`, which
   * would be a second copy of a number the CSS may change. All this renderer
   * does with it is hand it to `frameMatches`, which is where the arithmetic of
   * an off-centre viewport lives; nothing in here learns what the panel is for.
   */
  setOccludedRight(fraction: number): void {
    this.occludedRight = fraction;
  }

  /**
   * The colour every node wears while the size mode is armed, or null when it
   * is off.
   *
   * Colours, never sizes: handed one measurement per node, this loop would have
   * to evaluate a scale and a five-stop ramp 1 500 times a frame to recompute a
   * value that only changes when an answer arrives. The per-frame cost of the
   * mode is therefore one `Map.get`.
   */
  setSizeColors(colors: ReadonlyMap<string, number> | null): void {
    this.sizeColors = colors;
  }

  /**
   * Which paths are wearing an alarm right now.
   *
   * The `setSizeColors` shape a third time: an ANSWER, never a question. The
   * set is what `updateNodeAttributes` asks per node per frame ("is this one
   * exempt from the idle fade?") and what `updateAlarmMarkers` draws a bracket
   * from; nothing here knows a rule file exists.
   */
  setAlarms(paths: ReadonlySet<string>): void {
    this.alarmedPaths = paths;
  }

  /**
   * Who is working, who is blocked and who has just stopped.
   *
   * The `setSizeColors` shape: this takes an answer and never a question. It
   * is handed the per-agent record and knows nothing about `Notification`,
   * `Stop` or hooks — the classification happened in the daemon and the two
   * time-based cuts belong to `agentState.ts`, where they carry tests.
   *
   * An agent named here that has never fired an event gets its figure NOW,
   * standing at the layout's pinned centre: `PostToolUse` fires after a tool
   * runs, so an agent blocked on a permission prompt for its first tool call
   * has no file to be drawn on, and that is the commonest shape of exactly the
   * situation the wait ring exists to show.
   */
  setAgentStates(state: AgentStateModel): void {
    this.agentStates = state;
    const now = Date.now() / 1000;
    // A `stopped` entry the daemon keeps republishing after its window has
    // closed must NOT get a figure: it would be built here and torn down by
    // `updateActors` on the very next frame, so a reconnect's replay would cost
    // two sprites and a canvas per agent that finished hours ago.
    const departing = departedAgents(state, now);
    for (const entry of state.byAgent.values()) {
      if (entry.phase === "stopped" && !departing.includes(entry.agent)) continue;
      this.ensureActor(entry.agent, entry.label);
    }
  }

  /** Register a discrete event for its visual effect (actor beam + flash). */
  onEvent(event: AgentEvent): void {
    // Seeded tree entries and unattributed filesystem changes have no actor, so
    // there is no figure to place and no beam to fire. The model still flashes
    // the file itself for the watcher case.
    if (event.origin === "seed" || !event.agent) return;

    const actor = this.ensureActor(event.agent, event.label);
    // Put the figure straight onto its first target instead of letting it slide
    // in from the origin, which reads as an unrelated object crossing the tree.
    if (!actor.hasPos) {
      const target = this.layout.position(event.path);
      if (target) {
        actor.x = target.x;
        actor.y = target.y;
        actor.hasPos = true;
      }
    }
    // The model already flashed the file's color/highlight; we add the beam.
    // A read fires one too — the figure sliding to what the agent is looking at
    // is the whole point of the view — but in the read's violet rather than the
    // actor's colour (the line must not claim authorship of a change nobody
    // made) and with a life a fraction as long, so bursts of reads cannot fill
    // the fixed beam buffer at the writes' expense.
    const reading = event.type === "R";
    if (this.beams.length < MAX_BEAMS) {
      this.beams.push({
        actor: event.agent,
        target: event.path,
        color: reading ? READ_COLOR : actor.color,
        age: 0,
        life: reading ? READ_BEAM_LIFE_SECONDS : BEAM_LIFE_SECONDS,
      });
    }
  }

  /**
   * Show what the search found: highlight `matches`, ring `active`, and take
   * the camera over again (`frame` says whether to fit them all or approach the
   * active one).
   *
   * Every call rearms the camera, so a new query or an F3 wins back a view the
   * user had grabbed with the wheel.
   */
  setSearch(matches: readonly string[], active: string | null, frame: SearchFrame): void {
    this.searchMatches.clear();
    for (const path of matches) this.searchMatches.add(path);
    this.searchActivePath = active;
    this.searchFrame = frame;
    // A query matching nothing leaves the camera where the user left it: there
    // is nothing to frame, and yanking it to the origin would lose their place.
    this.searchArmed = this.searchMatches.size > 0;
  }

  /** Drop every highlight and hand the camera back to the automatic fit. */
  clearSearch(): void {
    this.searchMatches.clear();
    this.searchActivePath = null;
    this.searchArmed = false;
    this.searchMarker.visible = false;
    this.view = releaseToAuto(this.view);
  }

  /**
   * Drop everything that outlives the model, because the daemon switched roots.
   *
   * Only two things here are NOT reconciled from the model each frame, and both
   * would otherwise survive the new project: the actor figures and captions (an
   * agent of the old checkout would keep standing on the new tree) and the
   * in-flight beams (they point at paths that no longer exist). The nodes,
   * edges, directory labels, file-label slots and layout all follow an emptied
   * model on the next frame — `topologyChanged` sees the difference — so nothing
   * of that is repeated here.
   *
   * The camera goes back to the automatic fit: it may be parked on a region of
   * a project that is gone, and the new tree arrives elsewhere.
   */
  resetScene(): void {
    for (const actor of this.actors.values()) this.removeActor(actor);
    this.actors.clear();
    // The states describe actors of the project that was left; `main.ts` closes
    // the model on the same reset, and this keeps the two from disagreeing for
    // the frames in between.
    this.agentStates = createAgentStates();
    this.waitingNow.clear();
    this.departingNow.clear();
    this.beams.length = 0;
    // The file that was open belonged to the old project; its highlight would
    // otherwise be waiting for a path the new tree may never have.
    this.openFilePath = null;
    // The alarms named paths of the old project; `main.ts` empties the model on
    // the same reset, and parking the sprites here keeps the two from
    // disagreeing for the frames in between.
    this.alarmedPaths = new Set<string>();
    for (const slot of this.alarmMarkers) {
      slot.sprite.visible = false;
      slot.path = "";
    }
    // Highlights of matches in the old tree, and `releaseToAuto` with them.
    this.clearSearch();
  }

  /** Start the render loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number): void => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.lastTime) / 1000);
      this.lastTime = now;
      try {
        this.frame(dt);
      } catch (error) {
        // One bad frame must not end the animation: scheduling the next frame
        // from `finally` keeps a transient fault transient instead of leaving
        // a permanently black canvas.
        this.reportFrameError(error);
      } finally {
        requestAnimationFrame(loop);
      }
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  /** Resize buffers and camera to the current canvas size. */
  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    // The composer resizes its passes itself, in the renderer's own drawing
    // buffer size; resizing the bloom again with CSS pixels halved its targets
    // on a HiDPI screen, which softened everything it touched.
    this.composer.setSize(w, h);
    this.applyCameraFrustum(w / Math.max(1, h));
  }

  /** Log a failing frame once per distinct message, so it never floods. */
  private reportFrameError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.reportedFrameErrors.has(message)) return;
    this.reportedFrameErrors.add(message);
    console.error(`${APP_NAME}: frame failed:`, error);
  }

  private frame(dt: number): void {
    this.elapsed += dt;
    this.sim.tick(dt);

    const model = this.sim.listNodes();
    this.layout.sync(model);
    this.layout.tick();

    if (this.topologyChanged(model)) this.rebuildNodeBuffers(model);
    this.updateNodeAttributes(model);
    this.updateEdges();
    this.updateActors(dt);
    this.updateBeams(dt);
    this.updateCamera(model);
    // Last: labels are sized from the zoom `updateCamera` just settled on, and
    // positioned from the layout that moved this frame. Doing this only on
    // topology changes is what left directory names stranded behind their nodes.
    this.updateLabels(model);
    // After the labels: the rings are sized from the same per-frame metrics.
    this.updateSearchMarker();
    this.updateReadMarkers(model);
    // After the read rings, for the same reason they come after the labels:
    // both are sized from the metrics `updateLabels` settled this frame.
    this.updateAlarmMarkers(model);
    this.updateWaitRings();

    this.composer.render();
    // Text goes on top of the finished image, never through the bloom: keeping
    // the composer's output means not clearing the buffer first.
    this.renderer.autoClear = false;
    this.renderer.render(this.overlayScene, this.camera);
    this.renderer.autoClear = true;
  }

  private topologyChanged(model: readonly SimNode[]): boolean {
    if (model.length !== this.nodeIds.length) return true;
    for (const node of model) {
      if (!this.nodeIndex.has(node.path)) return true;
    }
    return false;
  }

  private rebuildNodeBuffers(model: readonly SimNode[]): void {
    const n = model.length;
    this.nodeIndex.clear();
    this.nodeIds = new Array<string>(n);
    this.edgeChild = [];
    this.edgeParent = [];

    for (let i = 0; i < n; i += 1) {
      const node = model[i];
      this.nodeIndex.set(node.path, i);
      this.nodeIds[i] = node.path;
      if (this.nodeIndex.has(node.parent) || node.parent === "") {
        this.edgeChild.push(node.path);
        this.edgeParent.push(node.parent);
      }
      if (node.kind === "dir") this.ensureDirLabel(node.path);
    }

    allocateNodeAttributes(this.nodeGeom, n);
    allocateEdgeAttributes(this.edgeGeom, this.edgeChild.length);

    this.pruneDirLabels();
  }

  private updateNodeAttributes(model: readonly SimNode[]): void {
    const pos = this.nodeGeom.getAttribute("position") as BufferAttribute;
    const col = this.nodeGeom.getAttribute("aColor") as BufferAttribute;
    const size = this.nodeGeom.getAttribute("aSize") as BufferAttribute;
    const posArr = pos.array as Float32Array;
    const colArr = col.array as Float32Array;
    const sizeArr = size.array as Float32Array;
    const dpr = this.renderer.getPixelRatio();

    for (const node of model) {
      const idx = this.nodeIndex.get(node.path);
      if (idx === undefined) continue;
      const p = this.layout.position(node.path);
      const x = p?.x ?? 0;
      const y = p?.y ?? 0;
      posArr[idx * 3] = x;
      posArr[idx * 3 + 1] = y;
      posArr[idx * 3 + 2] = 0;

      // A match is painted by the search, not by its own kind: full colour (no
      // idle fade -- the user asked for this node by name, so it must be
      // visible however cold it is) and a few pixels more, with the active one
      // larger still and pulsing so it reads apart from its siblings.
      // The open file is highlighted the same way, and as the ACTIVE one: it is
      // the node the panel covering the graph is showing.
      const opened = node.path === this.openFilePath;
      const matched = opened || (this.searchMatches.size > 0 && this.searchMatches.has(node.path));
      if (matched) {
        const active = opened || node.path === this.searchActivePath;
        const pulse = active
          ? 1 + SEARCH_PULSE_DEPTH * Math.sin(this.elapsed * SEARCH_PULSE_RATE)
          : 1;
        const base = node.kind === "dir" ? 3.5 : 6;
        const boost = active ? SEARCH_ACTIVE_SIZE_BOOST : SEARCH_SIZE_BOOST;
        this.scratchColor.setHex(SEARCH_COLOR);
        sizeArr[idx] = (base + boost) * pulse * dpr;
      } else if (node.kind === "dir") {
        // Below the matched branch on purpose: a match and the open file stay
        // cyan while the mode is armed, which is how the search keeps working.
        // An armed mode with no answer for this directory paints the grey it
        // already wore, rather than a second near-grey nothing could tell apart.
        const base =
          this.sizeColors?.get(node.path) ?? (this.sizeColors ? UNMEASURED_COLOR : DIR_COLOR);
        this.scratchColor.setHex(base).multiplyScalar(0.5);
        sizeArr[idx] = 3.5 * dpr;
      } else {
        // The size colour replaces the BASE colour and nothing else: the write
        // flash, the read tint, the idle fade and the point size below all still
        // apply on top, so a file being written still flashes amber over it.
        const base = this.sizeColors
          ? (this.sizeColors.get(node.path) ?? UNMEASURED_COLOR)
          : fileColor(node.path);
        const flash = hexToInt(node.color) ?? base;
        this.scratchColor.setHex(base).lerp(tmpColor.setHex(flash), node.highlight);
        // The read is blended AFTER the write's flash and on its own channel, so
        // a file that was just edited and is now being read shows both: the
        // amber is still in the mix, tinted violet in proportion to `reading`.
        // The tint stops short of 1 for that reason — a read never fully repaints
        // the colour of a change.
        if (node.reading > 0) {
          this.scratchColor.lerp(tmpColor.setHex(READ_COLOR), node.reading * READ_TINT);
        }
        // The one expression this feature changes in here. An alarmed node is
        // exempt from the idle fade, exactly as a match is above: an alarm
        // outlives the event that raised it by design, and one that faded out
        // over the next minute is an alarm nobody sees. The arithmetic and both
        // exemptions live in `nodeFade.ts`, which carries the tests.
        this.scratchColor.multiplyScalar(
          nodeOpacityFactor(node.opacity, { alarmed: this.alarmedPaths.has(node.path) }),
        );
        sizeArr[idx] = (6 + node.highlight * 8 + node.reading * READ_SIZE_BOOST) * dpr;
      }
      colArr[idx * 3] = this.scratchColor.r;
      colArr[idx * 3 + 1] = this.scratchColor.g;
      colArr[idx * 3 + 2] = this.scratchColor.b;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    size.needsUpdate = true;
    this.nodeGeom.setDrawRange(0, model.length);
  }

  private updateEdges(): void {
    const attr = this.edgeGeom.getAttribute("position") as BufferAttribute | undefined;
    if (!attr) return;
    const arr = attr.array as Float32Array;
    let w = 0;
    for (let i = 0; i < this.edgeChild.length; i += 1) {
      const c = this.layout.position(this.edgeChild[i]);
      const p = this.layout.position(this.edgeParent[i]) ?? { x: 0, y: 0 };
      if (!c) continue;
      arr[w++] = c.x; arr[w++] = c.y; arr[w++] = 0;
      arr[w++] = p.x; arr[w++] = p.y; arr[w++] = 0;
    }
    attr.needsUpdate = true;
    this.edgeGeom.setDrawRange(0, (w / 3) | 0);
  }

  private updateActors(dt: number): void {
    // Wall clock, not `this.elapsed`: the daemon stamps `ts` with `time.time()`
    // and both cuts are ages against it.
    const now = Date.now() / 1000;
    // Asked every frame, never once on adoption: a wait goes stale and a
    // departure completes while no frame arrives at all, so an answer computed
    // when the last one landed would be frozen. The two arrays the selectors
    // return are bounded by the actor count -- a handful -- and the sets they
    // are copied into are reused rather than reallocated.
    this.waitingNow.clear();
    for (const agent of waitingAgents(this.agentStates, now)) this.waitingNow.add(agent);
    this.departingNow.clear();
    for (const agent of departedAgents(this.agentStates, now)) this.departingNow.add(agent);

    for (const actor of this.actors.values()) {
      const entry = this.agentStates.byAgent.get(actor.agent);
      // An agent the daemon says has stopped and that the departure window has
      // already let go of: the figure is gone, and this is the first mechanism
      // in the program that ever removes one. Without it an afternoon of
      // subagents ends as a field of dim strangers standing in front of the two
      // that are working.
      if (entry?.phase === "stopped" && !this.departingNow.has(actor.agent)) {
        this.removeActor(actor);
        continue;
      }
      // `?? 0` is load-bearing now, and must not be tidied into a non-null
      // assertion: `this.actors` is the union of TWO inputs since
      // `setAgentStates` can create a figure, so an actor the simulation has
      // never seen an event for is an ordinary case rather than a bug.
      const intensity = this.sim.getActor(actor.agent)?.intensity ?? 0;
      const waiting = this.waitingNow.has(actor.agent);
      // The figure never fades out entirely: an idle agent is still present and
      // must stay findable, it just stops drawing attention. A BLOCKED agent is
      // the one you most want to see, so the floor goes to 1 for it -- dimming
      // it by idle decay is precisely backwards, and being idle is the whole of
      // what it is reporting.
      const alpha =
        (waiting ? 1 : 0.4 + 0.6 * intensity) * this.departureFade(actor.agent, entry?.ts, now);
      // An agent that has done nothing yet stands at the root of the tree: it
      // is cheap, it is a true statement, and an actor with no position is
      // hidden outright.
      if (!actor.hasPos && entry) {
        const root = this.layout.position(LAYOUT_ROOT_ID);
        if (root) {
          actor.x = root.x;
          actor.y = root.y;
          actor.hasPos = true;
        }
      }
      if (actor.hasPos) {
        actor.figure.position.set(actor.x, actor.y + AVATAR_WORLD_HEIGHT * 0.5, 2);
        actor.figure.visible = true;
        (actor.figure.material as SpriteMaterial).opacity = alpha;

        // Placement and size are `updateLabels`' job, which runs after the
        // camera has settled; here we only say whether the name is shown.
        actor.label.visible = true;
        (actor.label.material as SpriteMaterial).opacity = alpha;
      } else {
        actor.figure.visible = false;
        actor.label.visible = false;
      }
      // ease actor toward its most recent beam target
      const beam = this.latestBeamFor(actor.agent);
      if (beam) {
        const t = this.layout.position(beam.target);
        if (t) {
          const k = 1 - Math.pow(0.001, dt);
          actor.x += (t.x - actor.x) * k;
          actor.y += (t.y - actor.y) * k;
          actor.hasPos = true;
        }
      }
    }
  }

  /**
   * How much of a departing figure is left, 1 while it is not departing.
   *
   * The fade rides ON TOP of the idle decay rather than replacing it: the decay
   * stays the floor for every fact that never arrives -- a missed
   * `SubagentStop`, a killed process, a hook that turns out not to fire. A fact
   * retires a figure promptly; silence still only dims it, as it always did.
   */
  private departureFade(agent: string, ts: number | undefined, now: number): number {
    if (!this.departingNow.has(agent) || ts === undefined) return 1;
    const left = 1 - (now - ts) / DEPARTURE_SECONDS;
    return left < 0 ? 0 : left > 1 ? 1 : left;
  }

  /** Retire one actor: the figure, the caption and the ring it may be wearing. */
  private removeActor(actor: ActorView): void {
    this.scene.remove(actor.figure);
    disposeSprite(actor.figure);
    this.overlayScene.remove(actor.label);
    disposeSprite(actor.label);
    if (actor.waitRing) {
      this.scene.remove(actor.waitRing);
      disposeSprite(actor.waitRing);
      actor.waitRing = null;
    }
    this.actors.delete(actor.agent);
  }

  /**
   * Ring every blocked agent, pulsing, at a constant size in PIXELS.
   *
   * Runs after `updateLabels`, like the read rings, because it is sized from
   * the `worldPerPixel` that pass has just settled: the camera spans halfHeight
   * 2..4000, so a ring sized in world units is sub-pixel with the tree framed
   * and covers the screen on a single file. The sprite lives in the MAIN scene
   * -- unlike text, a glow through the bloom is exactly what is wanted.
   */
  private updateWaitRings(): void {
    for (const actor of this.actors.values()) {
      const waiting = this.waitingNow.has(actor.agent) && actor.hasPos;
      if (!waiting) {
        if (actor.waitRing) actor.waitRing.visible = false;
        continue;
      }
      // Built on first need, in the actor's own colour: the fact is about the
      // agent, so with three figures on screen the ring says WHICH one is
      // blocked without anybody reading a caption.
      if (!actor.waitRing) {
        actor.waitRing = makeWaitMarker(actor.color);
        this.scene.add(actor.waitRing);
      }
      const pulse = 1 + WAIT_PULSE_DEPTH * Math.sin(this.elapsed * WAIT_PULSE_RATE);
      const size = this.labelMetrics.worldPerPixel * WAIT_MARKER_PIXELS * pulse;
      actor.waitRing.visible = true;
      // On the figure, not on the ground under it, and just behind it in z.
      actor.waitRing.position.set(actor.x, actor.y + AVATAR_WORLD_HEIGHT * 0.5, 1.5);
      actor.waitRing.scale.set(size, size, 1);
      (actor.waitRing.material as SpriteMaterial).opacity = 0.9;
    }
  }

  private updateBeams(dt: number): void {
    let seg = 0;
    for (let i = this.beams.length - 1; i >= 0; i -= 1) {
      const beam = this.beams[i];
      beam.age += dt;
      if (beam.age >= beam.life) {
        this.beams.splice(i, 1);
        continue;
      }
      const actor = this.actors.get(beam.actor);
      const target = this.layout.position(beam.target);
      if (!actor || !actor.hasPos || !target || seg >= MAX_BEAMS) continue;
      const fade = 1 - beam.age / beam.life;
      this.scratchColor.setHex(beam.color).multiplyScalar(fade);
      const o = seg * 6;
      this.beamPos[o] = actor.x; this.beamPos[o + 1] = actor.y; this.beamPos[o + 2] = 0;
      this.beamPos[o + 3] = target.x; this.beamPos[o + 4] = target.y; this.beamPos[o + 5] = 0;
      this.beamColor[o] = this.scratchColor.r; this.beamColor[o + 1] = this.scratchColor.g; this.beamColor[o + 2] = this.scratchColor.b;
      this.beamColor[o + 3] = this.scratchColor.r; this.beamColor[o + 4] = this.scratchColor.g; this.beamColor[o + 5] = this.scratchColor.b;
      seg += 1;
    }
    (this.beamGeom.getAttribute("position") as BufferAttribute).needsUpdate = true;
    (this.beamGeom.getAttribute("color") as BufferAttribute).needsUpdate = true;
    this.beamGeom.setDrawRange(0, seg * 2);
  }

  private updateCamera(model: readonly SimNode[]): void {
    // The search outranks the automatic fit while it holds the camera.
    if (this.updateSearchCamera()) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of model) {
      const p = this.layout.position(node.path);
      if (!p) continue;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) return;

    const targetCX = (minX + maxX) / 2;
    const targetCY = (minY + maxY) / 2;
    const spanY = Math.max(maxY - minY, (maxX - minX) / Math.max(0.0001, this.aspect())) * 0.5 + 20;

    // `follow` is a no-op once the user has zoomed or panned.
    this.view = follow(
      this.view,
      { centerX: targetCX, centerY: targetCY, halfHeight: spanY },
      0.05,
    );
    this.syncCamera();
  }

  /**
   * Ease the camera onto what the search is pointing at, if anything.
   *
   * The target is recomputed EVERY FRAME from the live layout, not once when
   * the query changed: the force layout keeps moving the nodes, so a frame
   * chosen once slides its matches off the screen within a second.
   *
   * @returns whether the search took the camera this frame.
   */
  private updateSearchCamera(): boolean {
    if (!this.searchArmed || this.searchMatches.size === 0) return false;

    const points = this.framePoints;
    let count = 0;
    const add = (p: { x: number; y: number }): void => {
      let slot = points[count];
      if (!slot) {
        slot = { x: 0, y: 0 };
        points.push(slot);
      }
      slot.x = p.x;
      slot.y = p.y;
      count += 1;
    };

    if (this.searchFrame === "active") {
      const p = this.searchActivePath ? this.layout.position(this.searchActivePath) : undefined;
      if (p) add(p);
    } else {
      for (const path of this.searchMatches) {
        const p = this.layout.position(path);
        if (p) add(p);
      }
    }
    points.length = count;

    // The third argument is what keeps a match out from under a docked panel:
    // with 40% of the width covered, the centre of the VISIBLE band is not the
    // centre of the viewport.
    const target = frameMatches(points, this.aspect(), this.occludedRight);
    // Matches with no position yet (the layout has not placed them): leave the
    // camera alone this frame rather than jumping it to the origin.
    if (!target) return false;

    // `focusOn`, not `follow`: the user is usually already `manual` by the time
    // they give up looking and type a name.
    this.view = focusOn(this.view, target, SEARCH_FOCUS_EASE);
    this.syncCamera();
    return true;
  }

  /**
   * Put the ring on the active match, at a constant size in pixels.
   *
   * Sized from the per-frame `worldPerPixel` for the same reason labels are:
   * a world-sized ring is invisible with the project framed and fills the
   * screen on a single file.
   */
  private updateSearchMarker(): void {
    // The open file takes the ring while there is one: it is the node the user
    // is reading, and it needs no search behind it to be worth pointing at.
    const path = this.openFilePath ?? this.searchActivePath;
    const ringed = path !== null && (path === this.openFilePath || this.searchMatches.has(path));
    const p = ringed && path ? this.layout.position(path) : undefined;
    if (!p) {
      this.searchMarker.visible = false;
      return;
    }
    const size = this.labelMetrics.worldPerPixel * SEARCH_MARKER_PIXELS;
    this.searchMarker.visible = true;
    this.searchMarker.position.set(p.x, p.y, 1);
    this.searchMarker.scale.set(size, size, 1);
  }

  /**
   * Ring every file being read, pulsing, at a constant size in PIXELS.
   *
   * A write is a flash that decays and a read is a ring that pulses: that
   * difference in behaviour, not just in hue, is what makes a read read as a
   * read while it lasts. Three things are load-bearing here:
   *
   *  - the size comes from `labelMetrics.worldPerPixel`, like the search ring
   *    and the labels. The camera spans halfHeight 2..4000, so a ring sized in
   *    world units is sub-pixel with the tree framed and covers the screen on a
   *    single file;
   *  - the pool is fixed at {@link MAX_READ_MARKERS} and the busiest files win
   *    it, because an agent can read dozens of files a second;
   *  - a slot stays with its path while that path is still being read, so an
   *    arriving read does not shuffle every ring on screen (the same rule the
   *    file-label pool follows, for the same reason).
   */
  private updateReadMarkers(model: readonly SimNode[]): void {
    const candidates = this.readCandidates;
    let count = 0;
    for (const node of model) {
      if (node.kind !== "file" || node.reading <= READ_MARKER_MIN) continue;
      const p = this.layout.position(node.path);
      if (!p) continue;
      let candidate = candidates[count];
      if (!candidate) {
        candidate = { path: "", reading: 0, x: 0, y: 0 };
        candidates.push(candidate);
      }
      candidate.path = node.path;
      candidate.reading = node.reading;
      candidate.x = p.x;
      candidate.y = p.y;
      count += 1;
    }
    candidates.length = count;
    // Freshest first, so the cap drops the reads that are already fading rather
    // than an arbitrary subset. Sorted in place: no allocation.
    if (count > MAX_READ_MARKERS) candidates.sort(byReadingDesc);

    const pending = this.readByPath;
    pending.clear();
    const kept = Math.min(count, MAX_READ_MARKERS);
    for (let i = 0; i < kept; i += 1) pending.set(candidates[i].path, candidates[i]);

    for (const slot of this.readMarkers) {
      const held = slot.path ? pending.get(slot.path) : undefined;
      if (!held) {
        slot.sprite.visible = false;
        slot.path = "";
        continue;
      }
      pending.delete(slot.path);
      this.drawReadMarker(slot, held);
    }

    const incoming = pending.values();
    for (const slot of this.readMarkers) {
      if (slot.path) continue;
      const next = incoming.next();
      if (next.done) break;
      slot.path = next.value.path;
      this.drawReadMarker(slot, next.value);
    }
  }

  /**
   * Bracket every file wearing an alarm, at a constant size in PIXELS.
   *
   * Built on `updateReadMarkers`' structure and diverging from it in exactly
   * two places, both of them consequences of one fact -- an alarm does not
   * decay:
   *
   *  - there is no channel to rank a full pool by, so the slots already bound
   *    to a path keep it and only free slots are handed out. The oldest alarms
   *    are the ones that stay on screen, which is the right way round: the
   *    panel lists everything, and a marker that moved every time a new alarm
   *    opened would be a marker nobody could follow back to its dot;
   *  - the opacity is constant. A bracket that faded with the node under it
   *    would disappear over exactly the file nobody has touched in a while,
   *    which is the file most in need of a second look.
   *
   * Sized from `labelMetrics.worldPerPixel` like every other marker here: the
   * camera spans halfHeight 2..4000, so a bracket sized in world units is
   * sub-pixel with the tree framed and covers the screen on a single file.
   */
  private updateAlarmMarkers(model: readonly SimNode[]): void {
    const pending = this.alarmPending;
    pending.clear();
    if (this.alarmedPaths.size > 0) {
      for (const node of model) {
        if (node.kind !== "file") continue;
        if (!this.alarmedPaths.has(node.path)) continue;
        pending.add(node.path);
      }
    }

    for (const slot of this.alarmMarkers) {
      const held = slot.path !== "" && pending.has(slot.path);
      if (!held) {
        slot.sprite.visible = false;
        slot.path = "";
        continue;
      }
      pending.delete(slot.path);
      this.drawAlarmMarker(slot, slot.path);
    }

    const incoming = pending.values();
    for (const slot of this.alarmMarkers) {
      if (slot.path) continue;
      const next = incoming.next();
      if (next.done) break;
      slot.path = next.value;
      this.drawAlarmMarker(slot, slot.path);
    }
  }

  /** Place and size one assigned bracket, or park it if its node has moved out. */
  private drawAlarmMarker(slot: AlarmMarkerSlot, path: string): void {
    const p = this.layout.position(path);
    if (!p) {
      slot.sprite.visible = false;
      return;
    }
    const size = this.labelMetrics.worldPerPixel * ALARM_MARKER_PIXELS;
    slot.sprite.visible = true;
    // Between the read ring (0.5) and the search ring (1): an alarm outranks
    // the context of what is being read and is outranked by the node the user
    // asked for by name.
    slot.sprite.position.set(p.x, p.y, 0.75);
    slot.sprite.scale.set(size, size, 1);
    // Constant, unlike the read ring's: an alarm does not decay.
    (slot.sprite.material as SpriteMaterial).opacity = 0.9;
  }

  /** Place, size and fade one assigned read ring. */
  private drawReadMarker(slot: ReadMarkerSlot, pick: ReadCandidate): void {
    const pulse = 1 + READ_PULSE_DEPTH * Math.sin(this.elapsed * READ_PULSE_RATE);
    // The ring both grows with the read and breathes while it lasts; it shrinks
    // back toward the dot as `reading` decays, so it never lingers as a stale
    // circle around a file nobody is looking at any more.
    const size =
      this.labelMetrics.worldPerPixel * READ_MARKER_PIXELS * (0.6 + 0.4 * pick.reading) * pulse;
    slot.sprite.visible = true;
    // Behind the search ring (z 1) and the figures (z 2): a read is context, not
    // the thing the user asked for.
    slot.sprite.position.set(pick.x, pick.y, 0.5);
    slot.sprite.scale.set(size, size, 1);
    (slot.sprite.material as SpriteMaterial).opacity = 0.25 + 0.55 * pick.reading;
  }

  /** Copy the view state onto the camera. */
  private syncCamera(): void {
    this.camera.position.set(this.view.centerX, this.view.centerY, 100);
    this.applyCameraFrustum(this.aspect());
  }

  private applyCameraFrustum(aspect: number): void {
    const halfH = this.view.halfHeight;
    const halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  private aspect(): number {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    return w / Math.max(1, h);
  }

  private ensureActor(agent: string, label: string): ActorView {
    const existing = this.actors.get(agent);
    if (existing) {
      this.renameActor(existing, label);
      return existing;
    }
    const color = actorColor(agent);

    // The figure stays in the main scene: it is part of what should glow.
    const figure = makeAvatar(color);
    figure.visible = false;
    this.scene.add(figure);

    // The agent type when the daemon sent one; otherwise the shortened id, since
    // session ids are long and only their tail distinguishes two agents.
    const labelText = actorDisplayName(label, agent);
    const sprite = this.makeLabel(labelText, color);
    sprite.visible = false;
    this.overlayScene.add(sprite);

    const view: ActorView = {
      agent,
      color,
      x: 0,
      y: 0,
      hasPos: false,
      figure,
      label: sprite,
      labelText,
      waitRing: null,
    };
    this.actors.set(agent, view);
    return view;
  }

  /**
   * Repaint an actor's caption when a better one arrives.
   *
   * An actor is created by its first event, and that event may well come from
   * the watcher with no `label` at all -- the readable agent type only shows up
   * on the next hook frame. So the name is not fixed at creation. An empty or
   * unchanged caption is ignored: a good name is never replaced by a worse one,
   * and repainting costs a canvas and a texture upload.
   */
  private renameActor(view: ActorView, label: string): void {
    const next = actorDisplayName(label, view.agent);
    if (typeof label !== "string" || !label.trim() || next === view.labelText) return;

    const material = view.label.material as SpriteMaterial;
    material.map?.dispose();
    const { texture, aspect, emFraction } = this.makeLabelTexture(next, view.color);
    material.map = texture;
    material.needsUpdate = true;
    view.label.userData.aspect = aspect;
    view.label.userData.emFraction = emFraction;
    view.labelText = next;
  }

  private latestBeamFor(agent: string): Beam | undefined {
    for (let i = this.beams.length - 1; i >= 0; i -= 1) {
      if (this.beams[i].actor === agent) return this.beams[i];
    }
    return undefined;
  }

  private ensureDirLabel(path: string): void {
    if (this.dirLabels.has(path)) return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const sprite = this.makeLabel(name, DIR_COLOR);
    this.overlayScene.add(sprite);
    this.dirLabels.set(path, sprite);
  }

  /** Drop the sprites of directories that no longer exist. */
  private pruneDirLabels(): void {
    for (const [path, sprite] of this.dirLabels) {
      if (this.nodeIndex.has(path)) continue;
      this.overlayScene.remove(sprite);
      (sprite.material as SpriteMaterial).map?.dispose();
      (sprite.material as SpriteMaterial).dispose();
      this.dirLabels.delete(path);
    }
  }

  /**
   * Place, size and fade every name on screen. Runs each frame, because both
   * inputs move each frame: the force layout keeps pushing nodes around, and
   * the label's world size depends on the current zoom.
   */
  private updateLabels(model: readonly SimNode[]): void {
    const viewportHeight = this.canvas.clientHeight || window.innerHeight;
    const metrics = this.labelMetrics;
    // The height the TEXT must occupy; the sprite around it is taller by the
    // texture's padding, which `sizeLabel` adds back.
    metrics.em = labelWorldHeight(this.view.halfHeight, viewportHeight);
    metrics.offset = labelOffset(metrics.em);
    // World size of one device pixel. Landing a label between two of them is
    // what makes the linear filter smear glyphs even at a 1:1 texture size.
    metrics.worldPerPixel =
      (2 * this.view.halfHeight) /
      Math.max(1, viewportHeight * this.renderer.getPixelRatio());

    for (const [path, sprite] of this.dirLabels) {
      const p = this.layout.position(path);
      if (!p) {
        sprite.visible = false;
        continue;
      }
      sprite.visible = true;
      this.placeLabel(sprite, p.x, p.y + metrics.offset, 1);
      this.tintDirLabel(sprite, this.searchMatches.has(path));
    }

    for (const actor of this.actors.values()) {
      if (!actor.label.visible) continue;
      this.placeLabel(actor.label, actor.x, actor.y + AVATAR_WORLD_HEIGHT + metrics.offset, 2);
    }

    this.updateFileLabels(model);
  }

  /**
   * Put one label on the pixel grid at the size the current zoom asks for.
   *
   * The grid is anchored on the camera centre, so panning slides it with the
   * view instead of re-blurring every name at each intermediate position.
   */
  private placeLabel(sprite: Sprite, x: number, y: number, z: number): void {
    const { em, worldPerPixel } = this.labelMetrics;
    sprite.position.set(
      snapToPixelGrid(x, this.view.centerX, worldPerPixel),
      snapToPixelGrid(y, this.view.centerY, worldPerPixel),
      z,
    );
    sizeLabel(sprite, em);
  }

  /**
   * Tint a directory's name when the search matched it, and put it back when it
   * stops matching.
   *
   * The texture is baked in grey, so the match colour is applied through
   * `material.color` (a multiply) rather than by repainting a canvas every time
   * the query changes. The flag on `userData` is what keeps this a no-op on the
   * frames where nothing changed.
   */
  private tintDirLabel(sprite: Sprite, matched: boolean): void {
    if (sprite.userData.searchHit === matched) return;
    sprite.userData.searchHit = matched;
    const material = sprite.material as SpriteMaterial;
    material.color.setHex(matched ? SEARCH_COLOR : 0xffffff);
    material.opacity = matched ? 1 : 0.9;
  }

  /** Hand the sprite pool to the files that earned a name this frame. */
  private updateFileLabels(model: readonly SimNode[]): void {
    const candidates = this.labelCandidates;
    let count = 0;
    for (const node of model) {
      if (node.kind !== "file") continue;
      const p = this.layout.position(node.path);
      if (!p) continue;
      let candidate = candidates[count];
      if (!candidate) {
        candidate = { path: "", highlight: 0, x: 0, y: 0 };
        candidates.push(candidate);
      }
      candidate.path = node.path;
      // A file being read earns a name exactly as a file being written does:
      // `selectFileLabels` and `fileLabelOpacity` ask "how hot is this?", and a
      // read is heat of another kind. Folded in HERE rather than in `labels.ts`,
      // which keeps its contract — one number, whatever made it hot.
      candidate.highlight = Math.max(node.highlight, node.reading);
      candidate.x = p.x;
      candidate.y = p.y;
      count += 1;
    }
    candidates.length = count;

    // Resolved HERE, once the list has been refilled with this frame's
    // positions, and every frame rather than on the mouse event: the force
    // layout never settles, so a node slides under a pointer that has not
    // moved, and the camera changes what is under it too. The list already
    // holds the path and position of every placed file, so hovering costs no
    // second walk and no allocation.
    this.hoveredPath = hoverTarget(
      candidates,
      this.hoverActive ? this.pointerWorld(this.hoverX, this.hoverY, this.worldScratch) : null,
      // The click's radius, deliberately: what the pointer names is what it
      // would open, and a wider one would make the label a false promise.
      this.labelMetrics.worldPerPixel * PICK_RADIUS_PIXELS,
      this.dragPointer !== null,
    );
    // The drag owns the cursor while it lasts -- `pointerdown` set `grabbing`,
    // and a hover must not undo it mid-pan.
    if (this.dragPointer === null) {
      this.canvas.style.cursor = this.hoveredPath ? "pointer" : "grab";
    }

    const chosen = selectFileLabels(
      candidates,
      {
        centerX: this.view.centerX,
        centerY: this.view.centerY,
        halfHeight: this.view.halfHeight,
        aspect: this.aspect(),
      },
      this.fileLabels.length,
      // A match keeps its name even when it is cold and the camera is far out
      // framing all the others -- the two conditions that would hide it.
      this.searchMatches,
      // And so does the file under the pointer, which is asked about precisely
      // because nothing has touched it and it has no name.
      this.hoveredPath,
    );

    // Slots are assigned by identity, not by rank. Handing slot `i` to the i-th
    // hottest file would mean every new event shifts the whole list down one and
    // repaints every canvas; keeping a file on the sprite it already owns limits
    // repainting to the files actually entering or leaving the selection.
    const pending = this.chosenByPath;
    pending.clear();
    for (const pick of chosen) pending.set(pick.path, pick);

    for (const slot of this.fileLabels) {
      const held = slot.path ? pending.get(slot.path) : undefined;
      if (!held) {
        slot.sprite.visible = false;
        slot.path = "";
        continue;
      }
      pending.delete(slot.path);
      this.drawFileLabel(slot, held);
    }

    const incoming = pending.values();
    for (const slot of this.fileLabels) {
      if (slot.path) continue;
      const next = incoming.next();
      if (next.done) break;
      this.retextureFileLabel(slot, next.value.path);
      this.drawFileLabel(slot, next.value);
    }
  }

  /** Position, size and fade one assigned file label. */
  private drawFileLabel(slot: FileLabelSlot, pick: LabelCandidate): void {
    slot.sprite.visible = true;
    this.placeLabel(slot.sprite, pick.x, pick.y + this.labelMetrics.offset, 1);
    (slot.sprite.material as SpriteMaterial).opacity = fileLabelOpacity(
      pick.highlight,
      this.view.halfHeight,
      this.searchMatches.has(pick.path),
      pick.path === this.hoveredPath,
    );
  }

  /** Repaint a pooled sprite for a different file, disposing the old texture. */
  private retextureFileLabel(slot: FileLabelSlot, path: string): void {
    const material = slot.sprite.material as SpriteMaterial;
    material.map?.dispose();
    const name = path.slice(path.lastIndexOf("/") + 1);
    const { texture, aspect, emFraction } = this.makeLabelTexture(name, fileColor(path));
    material.map = texture;
    material.needsUpdate = true;
    slot.sprite.userData.aspect = aspect;
    slot.sprite.userData.emFraction = emFraction;
    slot.path = path;
  }

  /**
   * Render `text` to a texture, with the aspect ratio the sprite must keep and
   * the share of that texture its em box occupies.
   *
   * Split out from {@link makeLabel} so the file-label pool can repaint a
   * sprite it already owns instead of building a new one every time the
   * selection moves.
   */
  private makeLabelTexture(
    text: string,
    color: number,
  ): { texture: CanvasTexture; aspect: number; emFraction: number } {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const font = this.labelFont;
    ctx.font = `${font}px system-ui, sans-serif`;
    const metrics = ctx.measureText(text);
    // A quarter of the em box on each side: room for descenders and for the
    // antialiased edge, without spending most of the texture on emptiness.
    const pad = Math.max(2, Math.round(font * 0.25));
    canvas.width = Math.ceil(metrics.width) + pad * 2;
    canvas.height = font + pad * 2;
    // Resizing the canvas resets the context, so the font has to be set again.
    ctx.font = `${font}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.fillText(text, pad, canvas.height / 2);

    const texture = new CanvasTexture(canvas);
    // A 2D canvas hands us sRGB texels. Left as NoColorSpace they are treated
    // as linear on the way out, which shifts the gamma of every antialiased
    // edge and fattens the outline of each glyph.
    texture.colorSpace = SRGBColorSpace;
    // The sprite is rescaled every frame so the text always covers the same
    // number of device pixels as the raster, so sampling is near 1:1: a mipmap
    // chain could only ever be a blurrier version of what we want.
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = this.labelAnisotropy;

    return {
      texture,
      aspect: canvas.width / canvas.height,
      // Measured off the real canvas: the padding above is what separates the
      // height the caller asked for from the height the sprite needs.
      emFraction: font / canvas.height,
    };
  }

  /**
   * Build a text label sprite (white-ish text tinted by `color`).
   *
   * The sprite is left unscaled: `updateLabels` sizes it every frame from the
   * current zoom, so that a name stays the same number of pixels tall whether
   * the camera is framing one file or the whole project.
   */
  private makeLabel(text: string, color: number): Sprite {
    const { texture, aspect, emFraction } = this.makeLabelTexture(text, color);
    const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0.9 });
    const sprite = new Sprite(material);
    sprite.userData.aspect = aspect;
    sprite.userData.emFraction = emFraction;
    return sprite;
  }
}

/**
 * Scale a label sprite so its TEXT is `emWorldHeight` tall.
 *
 * Scaling the sprite itself to that height is the old bug: the texture carries
 * padding, so the glyphs came out at two thirds of the requested size.
 */
function sizeLabel(sprite: Sprite, emWorldHeight: number): void {
  const aspect = (sprite.userData.aspect as number | undefined) ?? 1;
  const emFraction = (sprite.userData.emFraction as number | undefined) ?? 1;
  const height = spriteHeightForEm(emWorldHeight, emFraction);
  // `aspect` measures the whole canvas, padding included, so it goes with the
  // sprite's height and not with the em box's.
  sprite.scale.set(aspect * height, height, 1);
}

/** Shared scratch color to avoid per-frame allocation in the lerp path. */
const tmpColor = new Color();

/** Sprite carrying the agent's figure, sized in world units. */
/**
 * Release a sprite's GPU memory: its texture first, then its material.
 *
 * Same discipline as `pruneDirLabels` — a canvas texture dropped without
 * `dispose` stays in the GL context, and switching roots a few times would leak
 * one per agent of every project seen.
 */
function disposeSprite(sprite: Sprite): void {
  const material = sprite.material as SpriteMaterial;
  material.map?.dispose();
  material.dispose();
}

function makeAvatar(color: number): Sprite {
  const texture = new CanvasTexture(createAvatarCanvas(color));
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    // Drawn on top of the tree: the figure is the subject, not part of the
    // structure it moves over.
    depthTest: false,
  });
  const sprite = new Sprite(material);
  sprite.scale.set(AVATAR_WORLD_HEIGHT, AVATAR_WORLD_HEIGHT, 1);
  return sprite;
}

/**
 * Sprite carrying the ring drawn around the active match.
 *
 * Built once and rescaled every frame, like every other pixel-sized thing here.
 */
function makeSearchMarker(): Sprite {
  const texture = new CanvasTexture(createSearchMarkerCanvas(SEARCH_COLOR));
  // A 2D canvas hands us sRGB texels; left linear the ring's antialiased edge
  // shifts gamma and thickens.
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  return new Sprite(
    new SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
}

/** Order read candidates by how recently they were read, freshest first. */
function byReadingDesc(a: ReadCandidate, b: ReadCandidate): number {
  return b.reading - a.reading;
}

/**
 * The one texture every read ring in the pool shares.
 *
 * Built once: all 24 sprites show the same shape in the same colour, and only
 * their position, scale and opacity change from frame to frame.
 */
/**
 * One wait ring, in one actor's colour.
 *
 * A texture per sprite rather than the read marker's single shared one: the
 * colour IS the information here, so two waiting agents cannot share it.
 */
function makeWaitMarker(color: number): Sprite {
  const texture = new CanvasTexture(createWaitMarkerCanvas(color));
  // A 2D canvas hands us sRGB texels; left linear each arc's antialiased edge
  // shifts gamma and thickens.
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  return new Sprite(
    new SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0 }),
  );
}

/**
 * The one texture every alarm bracket in the pool shares.
 *
 * Built once, like the read marker's: all the sprites show the same shape in
 * the same colour, and only their position and scale change frame to frame.
 */
function makeAlarmMarkerTexture(): CanvasTexture {
  const texture = new CanvasTexture(createAlarmMarkerCanvas(ALARM_MARKER_COLOR));
  // A 2D canvas hands us sRGB texels; left linear the antialiased edge of each
  // arm shifts gamma and thickens.
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function makeReadMarkerTexture(): CanvasTexture {
  const texture = new CanvasTexture(createReadMarkerCanvas(READ_COLOR));
  // A 2D canvas hands us sRGB texels; left linear the antialiased edge of each
  // ring shifts gamma and thickens.
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** Factory that keeps construction details out of `main.ts`. */
export function createRenderer(
  canvas: HTMLCanvasElement,
  sim: Simulation,
  options: RendererOptions = {},
): GourceRenderer {
  return new GourceRenderer(canvas, sim, options);
}
