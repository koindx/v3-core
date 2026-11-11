// Port of Uniswap v3-core test/TickBitmap.spec.ts. TickBitmapTest: the TickBitmap library compiled
// in tests/harness/pool-libraries.ts (tick spacing 1), run in the Koinos VM emulator.
// Not applicable: the gas cost tests.
const { KoinosVM } = require("../../vm/koinos-vm");
const { PoolLibraries } = require("../shared/pool-libraries");

/** the Uniswap TickBitmapTest contract */
class TickBitmapTest {
  constructor() {
    this.lib = new PoolLibraries(new KoinosVM(), "TickBitmapTest");
  }
  flipTick(tick) {
    this.lib.callVoid("bitmapFlipTick", tick);
  }
  nextInitializedTickWithinOneWord(tick, lte) {
    const [next, initialized] = this.lib.callString("bitmapNextInitializedTickWithinOneWord", tick, lte).split(",");
    return { next: Number(next), initialized: initialized === "true" };
  }
  isInitialized(tick) {
    return this.lib.call("bitmapIsInitialized", tick).res === 1;
  }
}

describe("TickBitmap", () => {
  let tickBitmap;

  beforeEach(() => {
    tickBitmap = new TickBitmapTest();
  });

  function initTicks(ticks) {
    for (const tick of ticks) tickBitmap.flipTick(tick);
  }

  describe("#isInitialized", () => {
    it("is false at first", () => {
      expect(tickBitmap.isInitialized(1)).toEqual(false);
    });
    it("is flipped by #flipTick", () => {
      tickBitmap.flipTick(1);
      expect(tickBitmap.isInitialized(1)).toEqual(true);
    });
    it("is flipped back by #flipTick", () => {
      tickBitmap.flipTick(1);
      tickBitmap.flipTick(1);
      expect(tickBitmap.isInitialized(1)).toEqual(false);
    });
    it("is not changed by another flip to a different tick", () => {
      tickBitmap.flipTick(2);
      expect(tickBitmap.isInitialized(1)).toEqual(false);
    });
    it("is not changed by another flip to a different tick on another word", () => {
      tickBitmap.flipTick(1 + 256);
      expect(tickBitmap.isInitialized(257)).toEqual(true);
      expect(tickBitmap.isInitialized(1)).toEqual(false);
    });
  });

  describe("#flipTick", () => {
    it("flips only the specified tick", () => {
      tickBitmap.flipTick(-230);
      expect(tickBitmap.isInitialized(-230)).toEqual(true);
      expect(tickBitmap.isInitialized(-231)).toEqual(false);
      expect(tickBitmap.isInitialized(-229)).toEqual(false);
      expect(tickBitmap.isInitialized(-230 + 256)).toEqual(false);
      expect(tickBitmap.isInitialized(-230 - 256)).toEqual(false);
      tickBitmap.flipTick(-230);
      expect(tickBitmap.isInitialized(-230)).toEqual(false);
      expect(tickBitmap.isInitialized(-231)).toEqual(false);
      expect(tickBitmap.isInitialized(-229)).toEqual(false);
      expect(tickBitmap.isInitialized(-230 + 256)).toEqual(false);
      expect(tickBitmap.isInitialized(-230 - 256)).toEqual(false);
    });

    it("reverts only itself", () => {
      tickBitmap.flipTick(-230);
      tickBitmap.flipTick(-259);
      tickBitmap.flipTick(-229);
      tickBitmap.flipTick(500);
      tickBitmap.flipTick(-259);
      tickBitmap.flipTick(-229);
      tickBitmap.flipTick(-259);

      expect(tickBitmap.isInitialized(-259)).toEqual(true);
      expect(tickBitmap.isInitialized(-229)).toEqual(false);
    });
  });

  describe("#nextInitializedTickWithinOneWord", () => {
    beforeEach(() => {
      // word boundaries are at multiples of 256
      initTicks([-200, -55, -4, 70, 78, 84, 139, 240, 535]);
    });

    describe("lte = false", () => {
      it("returns tick to right if at initialized tick", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(78, false)).toEqual({ next: 84, initialized: true });
      });
      it("returns tick to right if at initialized tick (negative)", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(-55, false)).toEqual({ next: -4, initialized: true });
      });

      it("returns the tick directly to the right", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(77, false)).toEqual({ next: 78, initialized: true });
      });
      it("returns the tick directly to the right (negative)", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(-56, false)).toEqual({ next: -55, initialized: true });
      });

      it("returns the next words initialized tick if on the right boundary", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(255, false)).toEqual({ next: 511, initialized: false });
      });
      it("returns the next words initialized tick if on the right boundary (negative)", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(-257, false)).toEqual({ next: -200, initialized: true });
      });

      it("returns the next initialized tick from the next word", () => {
        tickBitmap.flipTick(340);
        expect(tickBitmap.nextInitializedTickWithinOneWord(328, false)).toEqual({ next: 340, initialized: true });
      });
      it("does not exceed boundary", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(508, false)).toEqual({ next: 511, initialized: false });
      });
      it("skips entire word", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(255, false)).toEqual({ next: 511, initialized: false });
      });
      it("skips half word", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(383, false)).toEqual({ next: 511, initialized: false });
      });
    });

    describe("lte = true", () => {
      it("returns same tick if initialized", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(78, true)).toEqual({ next: 78, initialized: true });
      });
      it("returns tick directly to the left of input tick if not initialized", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(79, true)).toEqual({ next: 78, initialized: true });
      });
      it("will not exceed the word boundary", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(258, true)).toEqual({ next: 256, initialized: false });
      });
      it("at the word boundary", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(256, true)).toEqual({ next: 256, initialized: false });
      });
      it("word boundary less 1 (next initialized tick in next word)", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(72, true)).toEqual({ next: 70, initialized: true });
      });
      it("word boundary", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(-257, true)).toEqual({ next: -512, initialized: false });
      });
      it("entire empty word", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(1023, true)).toEqual({ next: 768, initialized: false });
      });
      it("halfway through empty word", () => {
        expect(tickBitmap.nextInitializedTickWithinOneWord(900, true)).toEqual({ next: 768, initialized: false });
      });
      it("boundary is initialized", () => {
        tickBitmap.flipTick(329);
        expect(tickBitmap.nextInitializedTickWithinOneWord(456, true)).toEqual({ next: 329, initialized: true });
      });
    });
  });
});
