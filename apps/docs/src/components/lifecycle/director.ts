// Plays the message lifecycle of the landing page. Each step plays when the reader scrolls
// to its window and the steps before it have played. A step that the reader has scrolled
// past, or jumped over, goes straight to its end. The controls of a window play its step
// again: Test with current rules runs the checks again. The markup shows the end of every
// step; this script takes each step back to its start before playing it.
//
// The lifecycle follows one message at a time, chosen at random when the page opens. Send
// sends the next one, and the steps after it play again for that message. What depends on
// the message is in the markup once for each message, in elements with data-message; the
// script shows those of the message it follows and hides the others.
//
// What moves is moved by the browser's compositor: the script sets attributes that CSS
// transitions of opacity and transform answer, and the dot of a score is a Web Animation
// of a transform. The script itself only writes text, one letter or one percent at a time.

/** One play of a step. It can be hurried to its end, or cancelled by a replay. */
interface Run {
  fast: boolean;
  cancelled: boolean;
  readonly wake: Set<() => void>;
}

class Cancelled extends Error {}

function hurry(run: Run) {
  run.fast = true;
  for (const wake of run.wake) wake();
}

async function pause(run: Run, milliseconds: number): Promise<void> {
  if (!run.fast) {
    await new Promise<void>((resolve) => {
      const wake = () => {
        window.clearTimeout(timer);
        run.wake.delete(wake);
        resolve();
      };
      const timer = window.setTimeout(wake, milliseconds);
      run.wake.add(wake);
    });
  }
  if (run.cancelled) throw new Cancelled();
}

/** The elements of a step for the message that the lifecycle follows. */
function shown(scope: ParentNode, selector: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => element.closest("[data-message][hidden]") === null,
  );
}

function part(scope: ParentNode, name: string): HTMLElement {
  const [found] = shown(scope, `[data-part="${name}"]`);
  if (found === undefined) throw new Error(`The lifecycle has no part "${name}".`);
  return found;
}

/** Shows one of the two states of a place. The other one is inert: nothing in it takes focus. */
function swap(scope: ParentNode, name: string, to: "a" | "b") {
  for (const element of scope.querySelectorAll<HTMLElement>(`[data-swap="${name}"]`)) {
    if (to === "a") element.dataset["current"] = "a";
    else delete element.dataset["current"];
    for (const state of element.children) {
      if (state instanceof HTMLElement) state.inert = state.dataset["alt"] !== to;
    }
  }
}

const reveal = (element: HTMLElement) => {
  element.dataset["on"] = "";
};

async function press(run: Run, element: HTMLElement) {
  element.dataset["pressed"] = "";
  await pause(run, 160);
  delete element.dataset["pressed"];
}

/** A text that the step types: what is typed, the caret, then the letters to come. */
interface Typed {
  readonly element: HTMLElement;
  readonly text: string;
  readonly typed: Text;
  readonly rest: Text;
}

function typedIn(scope: ParentNode): Typed {
  const element = scope.querySelector<HTMLElement>("[data-type]");
  if (element === null) throw new Error("The lifecycle has a part without a text to type.");
  const existing = element.querySelector(".type-rest")?.firstChild;
  const first = element.firstChild;
  if (existing instanceof Text && first instanceof Text) {
    return { element, text: first.data + existing.data, typed: first, rest: existing };
  }
  const text = element.textContent ?? "";
  const typed = document.createTextNode(text);
  const rest = document.createTextNode("");
  const caret = document.createElement("span");
  caret.className = "type-caret";
  const tail = document.createElement("span");
  tail.className = "type-rest";
  tail.append(rest);
  element.replaceChildren(typed, caret, tail);
  return { element, text, typed, rest };
}

function erase({ element, text, typed, rest }: Typed) {
  typed.data = "";
  rest.data = text;
  // An empty field shows its placeholder, when it has one.
  element.dataset["empty"] = "";
}

/** Types a text at about `pace` milliseconds a letter, slower after a sentence or a comma. */
async function type(run: Run, field: HTMLElement, pace: number) {
  const target = typedIn(field);
  const { element, text, typed, rest } = target;
  field.dataset["focus"] = "";
  await pause(run, 220);
  element.dataset["typing"] = "";
  delete element.dataset["empty"];
  for (let index = 1; index <= text.length && !run.fast; index += 1) {
    typed.data = text.slice(0, index);
    rest.data = text.slice(index);
    const letter = text[index - 1] ?? "";
    const rhythm = /[.?!]/u.test(letter) ? 7 : letter === "," ? 4 : 0.55 + Math.random() * 0.9;
    await pause(run, pace * rhythm);
  }
  typed.data = text;
  rest.data = "";
  delete element.dataset["typing"];
  await pause(run, 320);
  delete field.dataset["focus"];
}

const percent = (score: number) => `${Math.round(score * 100)}%`;

const scoreOf = (check: HTMLElement) =>
  Number(check.querySelector<HTMLElement>("[data-meter]")?.dataset["score"] ?? 0);

/** Writes a score beside its rule, and whether it is where the rule sends a message to review. */
function mark(check: HTMLElement, score: number) {
  const meter = check.querySelector<HTMLElement>("[data-meter]");
  const label = check.querySelector<HTMLElement>("[data-score-text]");
  if (meter === null) return;
  // The zones where the rule sends a message to review, written "from:to from:to".
  const inZone = (meter.dataset["zones"] ?? "").split(" ").some((zone) => {
    const [from, to] = zone.split(":").map(Number);
    return from !== undefined && to !== undefined && score >= from && score <= to;
  });
  // Called on every frame of a sweep: it writes only what changed.
  if (check.hasAttribute("data-fired") !== inZone) {
    check.toggleAttribute("data-fired", inZone);
    meter.querySelector("[data-rail]")?.toggleAttribute("data-in-zone", inZone);
  }
  // The text node keeps its place: replacing it would make the browser match the page's
  // structural selectors again, about 3ms of style work for each percent.
  const text = label?.firstChild;
  const written = percent(score);
  if (text instanceof Text && text.data !== written) text.data = written;
}

const railAt = (score: number) => `translateX(${(score * 100).toFixed(2)}%)`;

/** Puts the dot of a rule at a score, without moving it there. */
function setScore(check: HTMLElement, score: number) {
  const rail = check.querySelector<HTMLElement>("[data-rail]");
  if (rail === null) return;
  for (const animation of rail.getAnimations()) animation.cancel();
  rail.style.transform = railAt(score);
  mark(check, score);
}

/**
 * Moves the dot of a rule from 0 to its score, and counts the score up with it. The move is
 * a Web Animation of the rail's transform; each frame only reads how far it is.
 */
async function sweep(run: Run, check: HTMLElement) {
  const rail = check.querySelector<HTMLElement>("[data-rail]");
  const score = scoreOf(check);
  if (rail !== null && !run.fast) {
    // The rail is at its end under the animation, so nothing jumps when the animation is over.
    rail.style.transform = railAt(score);
    const animation = rail.animate([{ transform: railAt(0) }, { transform: railAt(score) }], {
      duration: 400 + 700 * score,
      // Accelerates then brakes: the dot is on screen from its start to its end.
      easing: "cubic-bezier(0.645, 0.045, 0.355, 1)",
    });
    while (animation.playState === "running" && !run.fast) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      // A cancelled play writes nothing more: its step is already back at its start.
      if (run.cancelled) break;
      mark(check, score * (animation.effect?.getComputedTiming().progress ?? 1));
    }
    animation.cancel();
  }
  if (run.cancelled) throw new Cancelled();
  setScore(check, score);
}

type Play = (run: Run, stage: HTMLElement) => Promise<void>;

/** The address of the form is copied: its button is pressed and the field flashes. */
async function copy(run: Run, stage: HTMLElement) {
  const address = part(stage, "address");
  swap(stage, "copy", "a");
  await press(run, part(stage, "copy"));
  swap(stage, "copy", "b");
  address.dataset["flash"] = "";
  await pause(run, 500);
  delete address.dataset["flash"];
}

/** A decision takes the message out of To review. */
async function decide(run: Run, stage: HTMLElement) {
  delete part(stage, "row").dataset["on"];
  swap(stage, "count", "a");
  await pause(run, 600);
}

/** The deliveries of an accepted message: each one is being sent, then is delivered. */
async function deliver(run: Run, stage: HTMLElement) {
  const deliveries = shown(stage, "[data-delivery]");
  for (const delivery of deliveries) swap(delivery, "status", "a");
  for (const delivery of deliveries) {
    await pause(run, 650);
    swap(delivery, "status", "b");
  }
}

/** What a control does in its own window before its step plays again. */
const firsts = new Map<string, Play>([
  ["copy", copy],
  ["decide", decide],
]);

/** The part of a step that a control plays again, in place of the whole step. */
const onlys = new Map<string, Play>([["deliver", deliver]]);

const plays = new Map<string, Play>([
  [
    "create",
    async (run, stage) => {
      await pause(run, 300);
      await type(run, part(stage, "name"), 75);
      swap(stage, "title", "b");
      await type(run, part(stage, "business"), 36);
      await pause(run, 200);
      reveal(part(stage, "settings"));
      await pause(run, 900);
      await copy(run, stage);
    },
  ],
  [
    "connect",
    async (run, stage) => {
      await type(run, part(stage, "address"), 11);
    },
  ],
  [
    "submit",
    async (run, stage) => {
      await type(run, part(stage, "name"), 80);
      await type(run, part(stage, "email"), 42);
      await type(run, part(stage, "message"), 21);
      await press(run, part(stage, "send"));
      swap(stage, "send", "b");
      await pause(run, 250);
      reveal(part(stage, "thanks"));
    },
  ],
  [
    "reception",
    async (run, stage) => {
      await pause(run, 250);
      for (const check of shown(stage, "[data-check]")) {
        check.dataset["active"] = "";
        await pause(run, 260);
        delete check.dataset["active"];
        for (const value of check.querySelectorAll<HTMLElement>("[data-reveal]")) reveal(value);
        await pause(run, 90);
      }
      await pause(run, 350);
      swap(stage, "verdict", "b");
    },
  ],
  [
    "analysis",
    async (run, stage) => {
      await pause(run, 400);
      for (const check of shown(stage, "[data-check]")) {
        delete check.dataset["pending"];
        for (const value of check.querySelectorAll<HTMLElement>("[data-reveal]")) reveal(value);
        await sweep(run, check);
        await pause(run, 260);
      }
      await pause(run, 200);
      swap(stage, "verdict", "b");
    },
  ],
  [
    "outcome",
    async (run, stage) => {
      await pause(run, 150);
      reveal(part(stage, "row"));
      swap(stage, "count", "b");
      await pause(run, 450);
      // A message to review has its actions, an accepted one its deliveries.
      for (const panel of shown(stage, '[data-part="actions"], [data-part="deliveries"]')) {
        reveal(panel);
      }
      await deliver(run, stage);
    },
  ],
]);

/**
 * Takes a step back to its start. Before the step plays again, the controls that the reader
 * has just used stay where they are.
 */
function rewind(stage: HTMLElement, flux: HTMLElement | null, again: boolean) {
  delete flux?.dataset["on"];
  for (const element of stage.querySelectorAll<HTMLElement>("[data-reveal]")) {
    if (again && element.querySelector("[data-control]") !== null) continue;
    delete element.dataset["on"];
  }
  const swaps = new Set<string>();
  for (const element of stage.querySelectorAll<HTMLElement>("[data-swap]")) {
    swaps.add(element.dataset["swap"] ?? "");
  }
  for (const name of swaps) swap(stage, name, "a");
  for (const element of stage.querySelectorAll<HTMLElement>("[data-part]")) {
    delete element.dataset["focus"];
    delete element.dataset["pressed"];
    delete element.dataset["flash"];
    if (element.querySelector("[data-type]") !== null) erase(typedIn(element));
  }
  for (const check of stage.querySelectorAll<HTMLElement>("[data-check]")) {
    delete check.dataset["active"];
    if (check.querySelector("[data-meter]") !== null) {
      check.dataset["pending"] = "";
      setScore(check, 0);
    }
  }
}

interface Step {
  readonly stage: HTMLElement;
  readonly flux: HTMLElement | null;
  readonly play: Play;
  state: "idle" | "playing" | "done";
  visible: boolean;
  run: Run | null;
  finished: Promise<void>;
}

/** How a control plays its step again. */
interface Again {
  /** What happens in the window of the control before the step goes back to its start. */
  readonly first: ((run: Run) => Promise<void>) | undefined;
  /** The part of the step that plays, where the control does not play the whole step. */
  readonly only: Play | undefined;
}

/** Shows what the lifecycle has for one message, and hides what it has for the others. */
function follow(lifecycle: HTMLElement, message: string) {
  lifecycle.dataset["following"] = message;
  for (const element of lifecycle.querySelectorAll<HTMLElement>("[data-message]")) {
    element.hidden = element.dataset["message"] !== message;
  }
}

/** Starts the lifecycle of one section. */
export function direct(lifecycle: HTMLElement) {
  const messages = [
    ...new Set(
      [...lifecycle.querySelectorAll<HTMLElement>("[data-message]")].flatMap(
        (element) => element.dataset["message"] ?? [],
      ),
    ),
  ];
  let following = 0;
  const followNext = () => {
    following = (following + 1) % Math.max(messages.length, 1);
    const message = messages[following];
    if (message !== undefined) follow(lifecycle, message);
  };
  const script = () => {
    for (const note of lifecycle.querySelectorAll<HTMLElement>("[data-scripted]")) {
      note.hidden = false;
    }
  };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Nothing plays: the section stays as written, and Send shows the end of every step
    // for the next message.
    for (const control of lifecycle.querySelectorAll<HTMLButtonElement>("[data-next]")) {
      control.addEventListener("click", followNext);
      control.disabled = false;
    }
    script();
    return;
  }
  if (!("IntersectionObserver" in window)) return;

  const steps: Step[] = [];
  for (const stage of lifecycle.querySelectorAll<HTMLElement>("[data-stage]")) {
    const play = plays.get(stage.dataset["stage"] ?? "");
    if (play === undefined) continue;
    steps.push({
      stage,
      flux: stage.querySelector<HTMLElement>("[data-flux]"),
      play,
      state: "idle",
      visible: false,
      run: null,
      finished: Promise.resolve(),
    });
  }

  /** Plays a step from its start, or plays it again as a control asks. */
  function start(step: Step, fast: boolean, again?: Again) {
    const run: Run = { fast, cancelled: false, wake: new Set() };
    step.run = run;
    step.state = "playing";
    step.stage.dataset["state"] = "playing";
    step.finished = (async () => {
      try {
        if (again?.only === undefined) {
          if (again !== undefined) {
            await again.first?.(run);
            rewind(step.stage, step.flux, true);
            // The start has to be painted before the step plays, or its transitions do not run.
            await pause(run, 50);
          }
          if (step.flux !== null) {
            reveal(step.flux);
            await pause(run, 850);
          }
          await step.play(run, step.stage);
        } else {
          await again.only(run, step.stage);
        }
      } catch (cause) {
        if (cause instanceof Cancelled) return;
        throw cause;
      }
      step.state = "done";
      step.stage.dataset["state"] = "done";
    })();
    return step.finished;
  }

  // Counts the changes of message: what was waiting to play for the message before stops.
  let changes = 0;

  /** Plays a step after the steps before it; those out of sight go straight to their end. */
  async function reach(index: number) {
    const change = changes;
    for (const [position, step] of steps.entries()) {
      if (position > index || change !== changes) return;
      if (step.state === "done") continue;
      if (step.state === "playing") {
        await step.finished;
        continue;
      }
      await start(step, position < index && !step.visible);
    }
  }

  /**
   * A control of a window is used. A step that plays goes to its end, as the control would
   * end it: Send sends the message before its text is typed. A step at its end plays again.
   */
  function use(step: Step, again: Again) {
    if (step.state === "idle") {
      void reach(steps.indexOf(step));
    } else if (step.state === "playing") {
      if (step.run !== null) hurry(step.run);
    } else {
      void start(step, false, again);
    }
  }

  following = Math.floor(Math.random() * messages.length) - 1;
  followNext();
  script();
  for (const step of steps) rewind(step.stage, step.flux, false);
  lifecycle.dataset["animated"] = "";

  // A step leaves the screen while it plays: nobody sees its end, so it gets there at once.
  const sight = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const step = steps.find(({ stage }) => stage === entry.target);
      if (step === undefined) continue;
      step.visible = entry.isIntersecting;
      if (!step.visible && step.state === "playing" && step.run !== null) hurry(step.run);
    }
  });
  // A step starts when the top of its window is a quarter of the screen above the bottom.
  const trigger = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = steps.findIndex(({ stage }) => stage.contains(entry.target));
        if (index === -1) continue;
        trigger.unobserve(entry.target);
        void reach(index);
      }
    },
    { rootMargin: "0px 0px -25% 0px" },
  );
  const watch = (step: Step) => {
    const stageWindow = step.stage.querySelector("[data-stage-window]");
    if (stageWindow !== null) trigger.observe(stageWindow);
  };

  /**
   * The lifecycle follows the next message. The steps after the one that sends it go back
   * to their start, and play for that message when the reader reaches them.
   */
  function send(from: Step) {
    changes += 1;
    for (const step of steps.slice(steps.indexOf(from) + 1)) {
      if (step.run !== null) {
        step.run.cancelled = true;
        hurry(step.run);
      }
      step.state = "idle";
      delete step.stage.dataset["state"];
      rewind(step.stage, step.flux, false);
      watch(step);
    }
    followNext();
  }

  for (const step of steps) {
    sight.observe(step.stage);
    watch(step);
    for (const control of step.stage.querySelectorAll<HTMLButtonElement>("[data-control]")) {
      // A control plays the step of its window, or the step it names: copying the address
      // of the form pastes it again in the code of the site.
      const named = control.dataset["control"];
      const target =
        named === "" ? step : steps.find(({ stage }) => stage.dataset["stage"] === named);
      if (target === undefined) continue;
      const first = firsts.get(control.dataset["first"] ?? "");
      const again: Again = {
        first: first === undefined ? undefined : (run) => first(run, step.stage),
        only: onlys.get(control.dataset["only"] ?? ""),
      };
      control.addEventListener("click", () => {
        // Send sends the next message, once the one before it is sent.
        if (control.hasAttribute("data-next") && target.state === "done") send(target);
        use(target, again);
      });
      control.disabled = false;
    }
  }
}
