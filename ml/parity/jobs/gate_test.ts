/**
 * Does the crop-prompt gate behave? Tests the DECISION, not the types.
 *
 * The failure mode being guarded against is an infinite loop: confidence
 * tracks species ambiguity rather than framing (Pearson 0.051 against relative
 * bird area), so cropping often does not raise it. Without a guard the app
 * would ask, get the same low confidence, and ask again forever.
 */
import { shouldPromptForCrop, CONFIDENCE_PROMPT_THRESHOLD } from '../../../src/lib/bird-id-local-adapter.ts'

let pass = 0
let fail = 0

function check(name: string, got: boolean, want: boolean) {
  if (got === want) {
    pass++
    console.log("  ok   " + name)
  } else {
    fail++
    console.log("  FAIL " + name + "  got " + got + " want " + want)
  }
}

const mk = (c: number) => ({ candidates: [{ species: "Mallard", confidence: c }] })

console.log("threshold = " + CONFIDENCE_PROMPT_THRESHOLD)
console.log("")

check("confident, first pass -> no prompt", shouldPromptForCrop(mk(0.95), false), false)
check("just above threshold -> no prompt", shouldPromptForCrop(mk(0.71), false), false)
check("just below threshold -> prompt", shouldPromptForCrop(mk(0.69), false), true)
check("very low -> prompt", shouldPromptForCrop(mk(0.10), false), true)

// The loop guard. This is the whole point of the second argument.
check("low AGAIN after cropping -> do NOT prompt",
      shouldPromptForCrop(mk(0.10), true), false)
check("confident after cropping -> no prompt",
      shouldPromptForCrop(mk(0.99), true), false)

// A classifier always returns 25 candidates, so empty means something broke.
check("no candidates at all -> prompt",
      shouldPromptForCrop({ candidates: [] }, false), true)
check("no candidates but already prompted -> do NOT loop",
      shouldPromptForCrop({ candidates: [] }, true), false)

console.log("")
console.log(pass + " passed, " + fail + " failed")
if (fail > 0) process.exit(1)
console.log("GATE LOGIC OK")
