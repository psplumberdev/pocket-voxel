#ifndef POCKETVOXEL_IOS_CONTROLS_H
#define POCKETVOXEL_IOS_CONTROLS_H
#include "../../vendor/pocketjs/engine/quickjs-c/pocket_runtime.h"

enum {
  BTN_UP = 1,
  BTN_DOWN = 2,
  BTN_LEFT = 4,
  BTN_RIGHT = 8,
  BTN_A = 16,
  BTN_B = 32,
  BTN_START = 64,
  BTN_SELECT = 128
};

static uint32_t buttons;
static uint32_t previous_buttons;
static int menu_open;
static int menu_pressed;
static int popup_pressed;
static int touch_was_down;
static int menu_touch_consumed;
static unsigned long action_sequence;
static int menu_contact_id = -1;
static int menu_contact_x;
static int menu_contact_y;
static unsigned int input_max_contacts;
static uint32_t input_buttons_seen;
static unsigned long input_chord_frames;

static uint32_t touch_buttons(int down, int x, int y) {
  int dx;
  int dy;
  int abs_x;
  int abs_y;
  if (!down || y < 240) return 0;

  dx = x - 75;
  dy = y - 350;
  abs_x = dx < 0 ? -dx : dx;
  abs_y = dy < 0 ? -dy : dy;
  if ((abs_x <= 23 && abs_y <= 65) || (abs_y <= 23 && abs_x <= 65)) {
    if (abs_x > abs_y && abs_x > 12) return dx < 0 ? BTN_LEFT : BTN_RIGHT;
    if (abs_y > 12) return dy < 0 ? BTN_UP : BTN_DOWN;
  }

  dx = x - 260;
  dy = y - 320;
  if (dx * dx + dy * dy <= 42 * 42) return BTN_A;
  dx = x - 202;
  dy = y - 375;
  if (dx * dx + dy * dy <= 40 * 40) return BTN_B;
  if (x >= 98 && x <= 144 && y >= 448 && y <= 474) return BTN_SELECT;
  if (x >= 169 && x <= 215 && y >= 448 && y <= 474) return BTN_START;
  return 0;
}

static int point_in_rect(int x, int y, int left, int top, int right, int bottom) {
  return x >= left && x <= right && y >= top && y <= bottom;
}

static void update_menu_touch(int down, int x, int y) {
  int menu_hit = point_in_rect(x, y, 137, 250, 183, 273);
  int popup_hit = point_in_rect(x, y, 36, 92, 284, 352);
  int done_hit = point_in_rect(x, y, 122, 305, 198, 333);

  if (!down) {
    if (popup_pressed && done_hit) {
      menu_open = 0;
      action_sequence += 1;
    } else if (menu_pressed && menu_hit) {
      menu_open = !menu_open;
      action_sequence += 1;
    }
    touch_was_down = 0;
    menu_pressed = 0;
    popup_pressed = 0;
    menu_touch_consumed = 0;
    return;
  }
  if (touch_was_down) return;
  touch_was_down = 1;

  if (menu_open) {
    menu_touch_consumed = 1;
    if (done_hit) {
      popup_pressed = 1;
    } else if (menu_hit) {
      menu_pressed = 1;
    } else if (!popup_hit) {
      menu_open = 0;
      action_sequence += 1;
    }
    return;
  }

  if (menu_hit) {
    menu_touch_consumed = 1;
    menu_pressed = 1;
  }
}

/* Keep menu ownership on one contact until release; other fingers may still
 * hold game controls. Preserve the last coordinates for release hit testing. */
static void voxel_controls_sample(const PocketRuntimeContactsInput *input) {
  unsigned int index;
  const PocketRuntimeContact *owner = NULL;
  uint32_t sampled = input->buttons;
  for (index = 0; index < input->contact_count; index += 1) {
    const PocketRuntimeContact *contact = &input->contacts[index];
    sampled |= touch_buttons(1, contact->x, contact->y);
    if (contact->id == menu_contact_id) owner = contact;
  }
  if (menu_contact_id >= 0 && owner == NULL) {
    update_menu_touch(0, menu_contact_x, menu_contact_y);
    menu_contact_id = -1;
  }
  if (menu_contact_id < 0 && input->contact_count > 0) {
    owner = &input->contacts[0];
    menu_contact_id = owner->id;
  }
  if (owner != NULL) {
    menu_contact_x = owner->x;
    menu_contact_y = owner->y;
    update_menu_touch(1, owner->x, owner->y);
  }
  buttons = menu_open || menu_touch_consumed ? 0 : sampled;
  if (buttons != 0 && buttons != previous_buttons) action_sequence += 1;
  previous_buttons = buttons;
  if (input->contact_count > input_max_contacts) input_max_contacts = input->contact_count;
  input_buttons_seen |= buttons;
  if ((buttons & (BTN_UP | BTN_DOWN | BTN_LEFT | BTN_RIGHT)) && (buttons & (BTN_A | BTN_B))) input_chord_frames += 1;
}
#endif
