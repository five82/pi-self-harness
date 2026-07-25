package sim

import "testing"

func selfHarnessSituation(half, seconds, offensePoints, defensePoints int) *gameState {
	return &gameState{
		half: half,
		secs: seconds,
		box:  [2]*TeamBox{{Points: offensePoints}, {Points: defensePoints}},
	}
}

func TestSelfHarnessPrehalftimePassMixUsesScoreAndFieldPosition(t *testing.T) {
	deep := &drivePos{off: 0, ballOn: 20, down: 1, toGo: 10}
	midfield := &drivePos{off: 0, ballOn: 50, down: 1, toGo: 10}
	boundary := &drivePos{off: 0, ballOn: 35, down: 1, toGo: 10}
	neutral := selfHarnessSituation(1, 600, 14, 14).passProb(midfield)

	if got := selfHarnessSituation(1, 90, 14, 21).passProb(deep); got <= neutral {
		t.Fatalf("trailing and deep pass probability = %.2f, want above neutral %.2f", got, neutral)
	}
	if got := selfHarnessSituation(1, 90, 21, 14).passProb(midfield); got <= neutral {
		t.Fatalf("leading at midfield pass probability = %.2f, want above neutral %.2f", got, neutral)
	}
	if got := selfHarnessSituation(1, 90, 21, 14).passProb(boundary); got <= neutral {
		t.Fatalf("leading at own 35 pass probability = %.2f, want above neutral %.2f", got, neutral)
	}
	if got := selfHarnessSituation(1, 90, 21, 14).passProb(deep); got >= neutral {
		t.Fatalf("leading and deep pass probability = %.2f, want below neutral %.2f", got, neutral)
	}
	if got := selfHarnessSituation(1, 600, 14, 21).passProb(deep); got != neutral {
		t.Fatalf("mid-half pass probability = %.2f, want neutral %.2f", got, neutral)
	}
}

func TestSelfHarnessPrehalftimePaceAndKneeling(t *testing.T) {
	run := playOutcome{yards: 4, time: timeRun}
	incomplete := playOutcome{time: timePassInc}
	deep := &drivePos{off: 0, ballOn: 20, down: 1, toGo: 10}
	midfield := &drivePos{off: 0, ballOn: 50, down: 1, toGo: 10}

	if got := selfHarnessSituation(1, 90, 14, 21).paceTime(deep, run); got >= timeRun {
		t.Fatalf("trailing hurry-up run took %d seconds, want under %d", got, timeRun)
	}
	if got := selfHarnessSituation(1, 90, 21, 14).paceTime(midfield, run); got >= timeRun {
		t.Fatalf("field-position hurry-up run took %d seconds, want under %d", got, timeRun)
	}
	if got := selfHarnessSituation(1, 90, 21, 14).paceTime(deep, run); got <= timeRun {
		t.Fatalf("half-ending run took %d seconds, want over %d", got, timeRun)
	}
	if got := selfHarnessSituation(1, 90, 14, 21).paceTime(deep, incomplete); got != timePassInc {
		t.Fatalf("incompletion took %d seconds, want %d", got, timePassInc)
	}

	if !selfHarnessSituation(1, 100, 21, 14).shouldKneel(deep) {
		t.Fatal("leading and deep with enough downs should kneel out the half")
	}
	if selfHarnessSituation(1, 100, 14, 21).shouldKneel(deep) {
		t.Fatal("trailing offense must not kneel before halftime")
	}
	if selfHarnessSituation(1, 100, 21, 14).shouldKneel(midfield) {
		t.Fatal("offense with field position must not kneel before halftime")
	}
	if selfHarnessSituation(1, 100, 21, 14).shouldKneel(&drivePos{off: 0, ballOn: 20, down: 3}) {
		t.Fatal("one remaining kneel cannot consume 100 seconds")
	}
}

func TestSelfHarnessFirstHalfKeepsEndgameOnlyDecisionsDisabled(t *testing.T) {
	state := selfHarnessSituation(1, 60, 14, 21)
	drive := &drivePos{off: 0, ballOn: 50, down: 4, toGo: 8}
	if state.fourthDownCall(drive, false, 57) {
		t.Fatal("first-half clock strategy enabled endgame fourth-down desperation")
	}
	if selfHarnessSituation(1, 60, 19, 21).goForTwo(0) {
		t.Fatal("first-half clock strategy enabled the two-point chart")
	}
}
