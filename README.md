# Azure Topology Graph MCP Server

A Model Context Protocol (MCP) server that queries Azure Resource Graph, ARM, and Network Watcher to create topology maps that Cursor can explore.

## Features

- **Resource Inventory**: Query resources across multiple subscriptions using Azure Resource Graph
- **Detailed Configuration**: Pull detailed configuration for specific resources using ARM APIs
- **Network Topology**: Build network topology using Azure Network Watcher
- **Graph Representation**: Represent infrastructure as nodes and edges
- **MCP Tools**: Expose powerful tools for searching, exploring, and analyzing Azure infrastructure

## Available Tools

- `search_resources`: Search Azure resources by name, type, or other properties
- `get_resource`: Get detailed information about a specific Azure resource
- `get_neighbors`: Get resources connected to a specific resource
- `find_path`: Find connection paths between two Azure resources
- `export_topology`: Export the complete topology graph (JSON or summary)
- `refresh_topology`: Refresh the topology cache by re-querying Azure

## Prerequisites

1. **Azure Service Principal**: You need an Azure service principal with appropriate permissions
2. **Azure Permissions**: The service principal needs at least `Reader` access to the subscriptions and resource groups you want to query
3. **Node.js**: Version 16 or later

## Setup

### 1. Clone and Install Dependencies

```bash
git clone <your-repo-url>
cd azure_mcp_graph
npm install
```

### 2. Configure Azure Credentials

Create a `.env` file in the project root:

```ini
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=your-service-principal-secret
SUBSCRIPTION_IDS=sub-id-1,sub-id-2,sub-id-3
DEFAULT_RG=MyWorkloadRG
DEFAULT_REGION=eastus
NETWORK_WATCHER_NAME=NetworkWatcher_eastus
```

### 3. Build the Server

```bash
npm run build
```

### 4. Configure Cursor MCP

Add the following to your Cursor MCP configuration file (usually `~/.cursor/config.json`):

```jsonc
{
  "mcpServers": {
    "azure-graph": {
      "command": "node",
      "args": ["/path/to/azure_mcp_graph/dist/server.js"],
      "env": {
        "AZURE_TENANT_ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "AZURE_CLIENT_ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "AZURE_CLIENT_SECRET": "your-service-principal-secret",
        "SUBSCRIPTION_IDS": "sub-id-1,sub-id-2,sub-id-3",
        "DEFAULT_RG": "MyWorkloadRG",
        "DEFAULT_REGION": "eastus",
        "NETWORK_WATCHER_NAME": "NetworkWatcher_eastus"
      }
    }
  }
}
```

## Usage Examples

Once configured, you can use the following commands in Cursor:

### Search for Resources
```
Search for all virtual machines in my infrastructure
```

### Explore Resource Relationships
```
Show me all resources connected to my VM named "web-server-01"
```

### Find Connectivity Paths
```
Find the network path between my application gateway and backend VMs
```

### Export Topology
```
Export a summary of my entire Azure topology
```

## Development

### Run in Development Mode
```bash
npm run dev
```

### Build
```bash
npm run build
```

### Clean Build Output
```bash
npm run clean
```

## Architecture

The server consists of several key components:

- **Azure Clients**: Interfaces with Azure Resource Graph, ARM, and Network Watcher APIs
- **Graph Builder**: Constructs topology graphs from Azure resource data
- **Relationship Analyzer**: Identifies and builds relationships between resources
- **MCP Tools**: Exposes functionality through the Model Context Protocol
- **Caching**: Intelligent caching with configurable TTL for performance

## Troubleshooting

### Authentication Issues
- Ensure your service principal has the correct permissions
- Verify your Azure credentials are correctly configured
- Check that your subscription IDs are valid and accessible

### Performance Issues
- The server caches topology data for 5 minutes by default
- Use `refresh_topology` tool to force a cache refresh
- Consider filtering by resource type for large subscriptions

### Network Issues
- Ensure your environment has access to Azure APIs
- Check firewall and proxy settings if running behind corporate networks

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the ISC License - see the package.json file for details.