The terminal workspace includes **Platform templates**. Configure the separate platform connection with `ace templates login --url <platform-origin>`, then open the panel. The initial Ace screen does not read platform credentials or fetch templates.

Type to search titles, descriptions, and categories. Tab changes the category, arrow keys select, and Enter retrieves the selected version's authorized graph. Ctrl+R reloads the catalog. A listed template whose graph is inaccessible cannot be run from Ace.

Enter values using the graph's input fields. Blank answers preserve typed defaults; arrays, objects, numbers, booleans, and nullable values use JSON. The form shows each complete schema and default through pagination. The review includes the materialized input values, selected version, and execution mode. Read every review page before pressing `y`; resizing restarts that review. Per-field input is limited to 64 KiB and the complete review to 1 MiB, with explicit errors for larger input.

Choose **Local runtime** to execute the fetched graph snapshot, using the local provider configuration and compatibility checks. Local model providers can charge for their calls. Choose **Platform (remote)** to execute the selected stored version using platform credits. Stored version contents can change before execution; the API pins version identity, not graph bytes. The reviewed input is submitted once. Remote execution does not require Python or local node availability.

Escape during an operation waits for local cleanup. During a remote run, this stops observation; the remote job can continue and consume credits. An interrupted or incomplete stream is not reported as successful or as a confirmed remote cancellation. Available run and job IDs remain in the result. Ace never automatically retries submission.

Results, errors, and multiline Markdown output are paginated. The complete review and its confirmation fit within the shared workspace at 40×24 or larger; smaller terminals block submission until enlarged. Ctrl+C waits for owned work to stop before restoring the terminal.

The catalog's deployed seed set and local portability are separate from this client flow; see [template portability](platform-template-portability.md).
