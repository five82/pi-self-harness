package league

import (
	"sort"
	"testing"

	"projectgm/internal/gen"
	"projectgm/internal/team"
)

func TestSelfHarnessScheduleIsCompleteAndSpreadsDivisionGames(t *testing.T) {
	league := New(gen.League(2026))
	for year := 1; year <= 12; year++ {
		schedule := league.BuildSchedule(year, nil)
		byTeam := make(map[*team.Team]map[int][]*team.Team, len(league.Teams))
		divisionHalves := make(map[*team.Team][2]int, len(league.Teams))
		for _, club := range league.Teams {
			byTeam[club] = map[int][]*team.Team{}
		}

		for _, game := range schedule {
			byTeam[game.Home][game.Week] = append(byTeam[game.Home][game.Week], game.Away)
			byTeam[game.Away][game.Week] = append(byTeam[game.Away][game.Week], game.Home)
			if game.Week == GamesPerTeam && !SameDivision(game.Home, game.Away) {
				t.Errorf("year %d final week has non-division game %s-%s", year, game.Away.Abbr(), game.Home.Abbr())
			}
			if SameDivision(game.Home, game.Away) {
				half := 0
				if game.Week > GamesPerTeam/2 {
					half = 1
				}
				for _, club := range []*team.Team{game.Home, game.Away} {
					counts := divisionHalves[club]
					counts[half]++
					divisionHalves[club] = counts
				}
			}
		}

		for _, club := range league.Teams {
			for week := 1; week <= GamesPerTeam; week++ {
				if got := len(byTeam[club][week]); got != 1 {
					t.Errorf("year %d: %s has %d games in week %d, want 1", year, club.Abbr(), got, week)
				}
			}
			if len(byTeam[club]) != GamesPerTeam {
				t.Errorf("year %d: %s appears in %d distinct weeks, want %d", year, club.Abbr(), len(byTeam[club]), GamesPerTeam)
			}
			if got := divisionHalves[club]; got != [2]int{3, 3} {
				t.Errorf("year %d: %s division split = %v, want [3 3]", year, club.Abbr(), got)
			}

			type matchup struct {
				week int
				opp  *team.Team
			}
			matchups := make([]matchup, 0, GamesPerTeam)
			for week, opponents := range byTeam[club] {
				for _, opponent := range opponents {
					matchups = append(matchups, matchup{week: week, opp: opponent})
				}
			}
			sort.Slice(matchups, func(i, j int) bool { return matchups[i].week < matchups[j].week })
			for index := 1; index < len(matchups); index++ {
				if matchups[index-1].opp == matchups[index].opp {
					t.Errorf("year %d: %s plays %s in consecutive weeks %d and %d", year, club.Abbr(), matchups[index].opp.Abbr(), matchups[index-1].week, matchups[index].week)
				}
			}
		}
	}
}
