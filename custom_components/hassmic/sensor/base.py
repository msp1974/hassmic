"""Provides the base class for hassmic sensors."""

from __future__ import annotations

import logging

from homeassistant.components.assist_pipeline.pipeline import PipelineEvent
from homeassistant.components.sensor import ENTITY_ID_FORMAT, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import STATE_UNKNOWN

from .. import util  # noqa: TID252
from ..proto.hassmic import ClientEvent  # noqa: TID252

_LOGGER = logging.getLogger(__name__)


class SensorBase(SensorEntity):
    """A generic hassmic Sensor.

    All sensors should inherit from this class.
    """

    _attr_native_value = STATE_UNKNOWN
    _attr_should_poll = False

    @property
    def hassmic_entity_name(self):
        """Return the name of the hassmic entity."""
        raise NotImplementedError(
            f"Class {type(self).__name__} has no hassmic_entity_name"
        )

    @property
    def icon(self):
        """Return the icon for the sensor."""
        return "mdi:help"

    def __init__(self, hass: HomeAssistant, config_entry: ConfigEntry) -> None:
        """Initialize hassmic Sensor."""
        super().__init__()
        util.InitializeEntity(self, ENTITY_ID_FORMAT, hass, config_entry)

    def handle_connection_state_change(self, new_state: bool):
        """Handle a connection state change."""
        self.available = new_state
        self.schedule_update_ha_state()

    def handle_pipeline_event(self, event: PipelineEvent):
        """Handle a PipelineEvent - deprecated."""

    def handle_client_event(self, event: ClientEvent):
        """Handle a ClientEvent."""


# vim: set ts=4 sw=4:
