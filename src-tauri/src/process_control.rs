#[cfg(windows)]
mod windows {
    use std::{
        ffi::c_void,
        io,
        mem::{size_of, zeroed},
        os::windows::io::RawHandle,
        sync::Arc,
    };

    use anyhow::{anyhow, Result};
    use tokio::process::Child;

    type Handle = *mut c_void;
    type Bool = i32;

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_LIMIT_BREAKAWAY_OK: u32 = 0x0000_0800;
    const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: u32 = 0x0000_1000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    unsafe extern "system" {
        fn CreateJobObjectW(job_attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            info_class: i32,
            info: *const c_void,
            info_len: u32,
        ) -> Bool;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
    }

    #[derive(Debug)]
    struct WindowsJobHandle {
        handle: Handle,
    }

    unsafe impl Send for WindowsJobHandle {}
    unsafe impl Sync for WindowsJobHandle {}

    impl WindowsJobHandle {
        fn create() -> Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error().into());
            }

            let mut limits = JobObjectExtendedLimitInformation {
                basic_limit_information: JobObjectBasicLimitInformation {
                    limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                        | JOB_OBJECT_LIMIT_BREAKAWAY_OK
                        | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
                    ..Default::default()
                },
                ..unsafe { zeroed() }
            };

            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    (&mut limits as *mut JobObjectExtendedLimitInformation).cast::<c_void>(),
                    size_of::<JobObjectExtendedLimitInformation>() as u32,
                )
            };

            if ok == 0 {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(handle);
                }
                return Err(error.into());
            }

            Ok(Self { handle })
        }

        fn assign_child(&self, child: &Child) -> Result<()> {
            let Some(process_handle) = child.raw_handle() else {
                return Err(anyhow!(
                    "child process did not expose a Windows process handle"
                ));
            };
            let process_handle = process_handle as RawHandle;
            if process_handle.is_null() {
                return Err(anyhow!(
                    "child process did not expose a Windows process handle"
                ));
            }

            let ok = unsafe { AssignProcessToJobObject(self.handle, process_handle as Handle) };
            if ok == 0 {
                return Err(io::Error::last_os_error().into());
            }

            Ok(())
        }

        fn terminate(&self, exit_code: u32) -> Result<()> {
            let ok = unsafe { TerminateJobObject(self.handle, exit_code) };
            if ok == 0 {
                return Err(io::Error::last_os_error().into());
            }
            Ok(())
        }
    }

    impl Drop for WindowsJobHandle {
        fn drop(&mut self) {
            unsafe {
                if !self.handle.is_null() {
                    CloseHandle(self.handle);
                }
            }
        }
    }

    #[derive(Clone, Debug)]
    pub struct JobHandle(Arc<WindowsJobHandle>);

    impl JobHandle {
        pub fn create_and_assign(child: &Child) -> Result<Self> {
            let handle = WindowsJobHandle::create()?;
            handle.assign_child(child)?;
            Ok(Self(Arc::new(handle)))
        }

        pub fn terminate(&self, exit_code: u32) -> Result<()> {
            self.0.terminate(exit_code)
        }
    }
}

#[cfg(windows)]
pub use windows::JobHandle;

#[cfg(not(windows))]
#[derive(Clone, Debug)]
pub struct JobHandle;

#[cfg(not(windows))]
impl JobHandle {
    pub fn create_and_assign(_child: &tokio::process::Child) -> anyhow::Result<Self> {
        Ok(Self)
    }

    pub fn terminate(&self, _exit_code: u32) -> anyhow::Result<()> {
        Ok(())
    }
}
