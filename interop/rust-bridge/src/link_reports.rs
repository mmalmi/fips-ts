//! Native MMP wire decoding and link-report cadence for the TS interoperability test.
use std::io;
use std::time::{Duration, Instant};

use fips_core::mmp::{MmpMetrics, ReceiverReport, ReceiverState, SenderState};

pub fn run() -> io::Result<()> {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    let mut sender = SenderState::new();
    let mut receiver = ReceiverState::new(32);
    let mut metrics = MmpMetrics::new();
    let start = Instant::now();
    for sample in 0..7_u32 {
        let timestamp = 1_000 + sample * 1_000;
        let now = start + Duration::from_millis(u64::from(timestamp));
        // One authenticated FMP SenderReport frame: 16 header + 4 timestamp
        // + 48 report bytes + 16 authentication tag = 84 bytes.
        sender.record_sent(u64::from(sample), timestamp, 84);
        let sr = sender.build_report(now).expect("recorded packet");
        super::write_frame(&mut stdout, &sr.encode())?;

        let encoded = super::read_frame(&mut stdin)?;
        if encoded.len() != 68 || encoded[0] != 0x02 {
            return Err(io::Error::other("expected a 68-byte link ReceiverReport"));
        }
        let rr = ReceiverReport::decode(&encoded[1..])
            .map_err(|error| io::Error::other(format!("receiver report: {error:?}")))?;
        if rr.highest_counter != u64::from(sample)
            || rr.cumulative_packets_recv != u64::from(sample + 1)
            || rr.cumulative_bytes_recv != u64::from(sample + 1) * 84
            || rr.interval_packets_recv != 1
            || rr.interval_bytes_recv != 84
            || rr.timestamp_echo != timestamp
            || rr.dwell_time != 5
        {
            return Err(io::Error::other(format!(
                "incorrect receiver measurements: {rr:?}"
            )));
        }
        metrics.process_receiver_report(&rr, timestamp + 50, now + Duration::from_millis(50));
        let srtt = metrics
            .srtt_ms()
            .ok_or_else(|| io::Error::other("missing SRTT"))?;
        sender.update_report_interval_from_srtt((srtt * 1_000.0) as i64);
        receiver.update_report_interval_from_srtt((srtt * 1_000.0) as i64);
        let mut result = Vec::new();
        result.extend_from_slice(&(sender.report_interval().as_millis() as u32).to_le_bytes());
        result.extend_from_slice(&(receiver.report_interval().as_millis() as u32).to_le_bytes());
        result.extend_from_slice(&(srtt as u32).to_le_bytes());
        super::write_frame(&mut stdout, &result)?;
    }
    Ok(())
}
