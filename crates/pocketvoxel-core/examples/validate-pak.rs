//! Validate a packaged asset file using the exact PSP streaming index reader.
use pocketvoxel_core::pak::index::{read_index, IndexError, ReadAt};
use std::{fs::File, io::{Read, Seek, SeekFrom}};
struct Source { file: File, len: u64 }
impl ReadAt for Source {
    fn len(&self) -> u64 { self.len }
    fn read_exact_at(&mut self, offset: u64, out: &mut [u8]) -> Result<(), IndexError> {
        self.file.seek(SeekFrom::Start(offset)).map_err(|_| "seek failed")?;
        self.file.read_exact(out).map_err(|_| "read failed")
    }
}
fn main() {
    for path in std::env::args().skip(1) {
        let file = File::open(&path).expect("open asset pack");
        let len = file.metadata().unwrap().len();
        match read_index(&mut Source { file, len }) {
            Ok(index) => println!("VALID {path}: {len} bytes, {} maps, {} atlas pages", index.maps.len(), index.atlases.len()),
            Err(error) => { eprintln!("INVALID {path}: {error}"); std::process::exit(1); }
        }
    }
}
