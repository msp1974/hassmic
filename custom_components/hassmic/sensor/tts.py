"""Defines the `stt` sensor."""

from __future__ import annotations

import logging

from ..proto.hassmic import ClientEvent, betterproto  # noqa: TID252
from . import base

_LOGGER = logging.getLogger(__name__)


class TTS(base.SensorBase):
    """Defines a sensor with the TTS state."""

    @property
    def hassmic_entity_name(self):
        """Return the name of the hassmic entity."""
        return "tts"

    @property
    def icon(self):
        """Return the icon for the sensor."""
        return "mdi:ear-hearing"

    def handle_client_event(self, event: ClientEvent):
        """Handle a ClientEvent for TTS."""
        (which, val) = betterproto.which_one_of(event, "event")
        if which == "wyoming_event":
            try:
                (which, wevent) = betterproto.which_one_of(val, "event")
                match which:
                    case "synthesize":
                        txt = wevent.text
                        _LOGGER.debug("Setting TTS state to %s", txt)
                        self.native_value = (
                            txt if len(txt) <= 255 else (txt[:252] + "...").strip()
                        )
                        self.extra_state_attributes = {
                            "speech": txt,
                        }

            except Exception as e:  # noqa: BLE001
                _LOGGER.warning("Error processing wyoming event: %s", e)

        self.schedule_update_ha_state()


# vim: set ts=4 sw=4:
