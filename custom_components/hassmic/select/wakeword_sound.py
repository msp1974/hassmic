"""Defines the wakeword sound."""

from __future__ import annotations

import logging

import betterproto

from homeassistant.components.select import ENTITY_ID_FORMAT, SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .. import util
from ..proto import hassmic as proto

_LOGGER = logging.getLogger(__name__)

WAKEWORD_SOUND_OPTIONS = [
    "No Sound",
    "HomeAssistant",
    "Alexa",
    "Ding",
    "Bubble",
]


class WakeWordSound(SelectEntity):
    """Selector for wakeword sounds."""

    def __init__(self, hass: HomeAssistant, config_entry: ConfigEntry) -> None:
        """Initialize."""
        super().__init__()
        self.hassmic_entity_name = "wakeword_sound"
        util.InitializeEntity(self, ENTITY_ID_FORMAT, hass, config_entry)

        self._hass = hass
        self._config_entry = config_entry
        self._hassmic = config_entry.runtime_data

        # self._attr_current_option = WAKEWORD_SOUND_OPTIONS[0]
        self._attr_current_option = None
        self._attr_options = WAKEWORD_SOUND_OPTIONS

    async def async_select_option(self, option: str) -> None:
        """Change the selected option."""
        self._attr_current_option = option
        self.send_wakewordsound(option)

    def handle_client_event(self, event: proto.ClientEvent):
        """Handle a client event."""
        (which, val) = betterproto.which_one_of(event, "event")
        match which:
            case "set_wakeword_sound":
                if val:
                    self.select_option(val.wakeword_sound)
            case _:
                pass  # ignore cases not listed here

        self.schedule_update_ha_state()

    def handle_saved_settings(self, ss: proto.SavedSettings):
        """Handle saved settings from the client."""
        if ss.wakeword_sound is not None:
            setting = ss.wakeword_sound
            if setting not in WAKEWORD_SOUND_OPTIONS:
                setting = WAKEWORD_SOUND_OPTIONS[0]
            _LOGGER.debug(
                "Setting wakeword sound to %s due to saved settings",
                setting,
            )
            self._attr_current_option = ss.wakeword_sound
            self.schedule_update_ha_state()
        else:
            _LOGGER.warning(
                "Got saved settings from client, but no wakeword sound is specified!"
            )

    def handle_connection_state_change(self, new_state: bool):
        """If the remote device just reconnected, remind it what settings it should have."""
        _LOGGER.debug("Connection state change")
        if new_state and self.current_option is not None:
            self.send_wakewordsound(self.current_option)

        self.available = new_state
        self.schedule_update_ha_state()

    def send_wakewordsound(self, value: str):
        """Send the wakeword sound setting to the remote."""
        if value not in WAKEWORD_SOUND_OPTIONS:
            _LOGGER.error("Invalid wakeword sound option: %s", value)
            return

        _LOGGER.info("Sending wakeword sound setting: %s", value)
        self._hassmic.connection_manager.send_enqueue(
            proto.HassmicCommand(set_wakeword_sound=value, internal=False)
        )


# vim: set ts=4 sw=4:
