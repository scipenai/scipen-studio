//! Optional IM channel building blocks.
//!
//! These are not part of the ordinary embedded-agent path. Enable
//! `snaca-sdk` feature `channel-protocol` for wire types, or `channel-host`
//! when embedding the stdio plugin host.

#[cfg(feature = "channel-protocol")]
pub use snaca_channel_protocol as protocol;

#[cfg(feature = "channel-host")]
pub use snaca_channel_host as host;
