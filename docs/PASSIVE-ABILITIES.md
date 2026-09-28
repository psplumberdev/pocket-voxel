# Party and field abilities

START → POKEMON shows all six party members, HP, levels, and status. Select a
member to make it lead, swap its position, control it in OVERWORLD ATTACK, or
use a learned Fly, Dig, or Teleport move. B backs out; START closes the party
menu. START from field control returns to the start menu.

Field control uses the selected species' types, without requiring a move or
badge. Flying types cross water and ledges in both directions; Water types
cross water. Walls, NPCs, map bounds, and unrelated tile barriers still block.
All species with party icons can be selected; species without a dedicated
walking sprite use their party icon. Leaving field control on water or a
ledge returns the trainer to the last safe land position (unless already
surfing on water).

While the controlled Pokémon is on water, visible encounters spawn on water
using that map's surf encounter table, species, levels, and weights. Maps
without water encounters do not invent a replacement table. Ranged attacks
can cross water.

Healthy party members can use learned travel moves without spending PP:

- Fly: outdoors, choose a previously visited town/city in the cooked map set.
  Destinations are recorded in the save from this version onward.
- Dig: leave a cave, forest, cemetery, or facility for its remembered outdoor
  entrance. It has no effect where no valid escape destination exists.
- Teleport: outdoors, return to the last healing checkpoint without healing.

In turn-based battles, Fly and Dig charge for a turn while invulnerable, then
attack, spending PP once. Teleport retains its wild-battle escape effect and
fails against trainers. In overworld combat, Fly/Dig retain their timed
attacks and Teleport retains the existing ranged damage attack; travel is a
separate party action.

Escape Rope leaves eligible dungeons from the bag. In a wild turn-based
battle it guarantees escape; it cannot escape trainers. Invalid use does not
consume it. Rare Candy works from the field and battle bags: gain one level,
recalculate stats/experience, offer learned moves, and check evolution
(immediately after field messages, or after battle). It does not increase stat
experience or cure status. At the level cap it has no effect and is not used.
