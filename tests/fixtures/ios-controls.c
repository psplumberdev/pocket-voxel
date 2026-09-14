#include <assert.h>
#include "../../host/iphone4s/controls.h"

int main(void) {
  PocketRuntimeContactsInput input = {0};
  input.contact_count = 2;
  input.contacts[0] = (PocketRuntimeContact){3, 120, 350, 1};
  input.contacts[1] = (PocketRuntimeContact){7, 260, 320, 1};
  voxel_controls_sample(&input);
  assert(buttons == (BTN_RIGHT | BTN_A));
  assert(input_max_contacts == 2 && input_chord_frames == 1);
  assert(action_sequence == 1);
  voxel_controls_sample(&input);
  assert(action_sequence == 1);

  /* Releasing the direction must retain the other finger's A button. */
  input.contacts[0] = input.contacts[1];
  input.contact_count = 1;
  voxel_controls_sample(&input);
  assert(buttons == BTN_A);
  input.contact_count = 0;
  voxel_controls_sample(&input);
  assert(buttons == 0);

  /* A released menu contact has no entry in the host's next snapshot. */
  input.contact_count = 1;
  input.contacts[0] = (PocketRuntimeContact){4, 160, 261, 1};
  voxel_controls_sample(&input);
  assert(menu_pressed && buttons == 0);
  input.contact_count = 0;
  voxel_controls_sample(&input);
  assert(menu_open);
  input.contact_count = 2;
  input.contacts[0] = (PocketRuntimeContact){0, 160, 320, 1};
  input.contacts[1] = (PocketRuntimeContact){1, 260, 320, 1};
  voxel_controls_sample(&input);
  assert(popup_pressed && buttons == 0);
  input.contact_count = 0;
  voxel_controls_sample(&input);
  assert(!menu_open && !popup_pressed && !menu_touch_consumed);

  /* A drag out cancels a menu click; a held contact cannot reopen it. */
  input.contact_count = 1;
  input.contacts[0] = (PocketRuntimeContact){2, 160, 261, 1};
  voxel_controls_sample(&input);
  input.contacts[0].x = 310;
  voxel_controls_sample(&input);
  input.contact_count = 0;
  voxel_controls_sample(&input);
  assert(!menu_open);

  input.buttons = BTN_SELECT;
  voxel_controls_sample(&input);
  assert(buttons == BTN_SELECT);
  assert((input_buttons_seen & (BTN_RIGHT | BTN_A)) == (BTN_RIGHT | BTN_A));
  return 0;
}
