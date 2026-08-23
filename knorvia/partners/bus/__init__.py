"""Message bus module for decoupled channel-agent communication."""

from knorvia.partners.bus.events import InboundMessage, OutboundMessage
from knorvia.partners.bus.queue import MessageBus

__all__ = ["MessageBus", "InboundMessage", "OutboundMessage"]
