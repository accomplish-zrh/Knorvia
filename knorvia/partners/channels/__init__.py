"""Chat channels module with plugin architecture."""

from knorvia.partners.channels.base import BaseChannel
from knorvia.partners.channels.manager import ChannelManager

__all__ = ["BaseChannel", "ChannelManager"]
