#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { DefaultAzureCredential } = require('@azure/identity');
const { ResourceGraphClient } = require('@azure/arm-resourcegraph');
const { NetworkManagementClient } = require('@azure/arm-network');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Environment validation schema
const envSchema = z.object({
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_CLIENT_SECRET: z.string().optional(),
  SUBSCRIPTION_IDS: z.string(),
  DEFAULT_RG: z.string().optional(),
  DEFAULT_REGION: z.string().optional(),
  NETWORK_WATCHER_NAME: z.string().optional(),
});

// Validate environment variables
const env = envSchema.parse(process.env);
const subscriptionIds = env.SUBSCRIPTION_IDS.split(',').map((id: string) => id.trim());

// Azure clients
let resourceGraphClient: any;
let networkClients: Map<string, any> = new Map();

// Initialize Azure clients
async function initializeClients() {
  try {
    const credential = new DefaultAzureCredential();
    
    // Initialize Resource Graph client
    resourceGraphClient = new ResourceGraphClient(credential);
    
    // Initialize Network Management clients for each subscription
    for (const subscriptionId of subscriptionIds) {
      const networkClient = new NetworkManagementClient(credential, subscriptionId);
      networkClients.set(subscriptionId, networkClient);
    }
    
    console.error('Azure clients initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Azure clients:', error);
    throw error;
  }
}

// Graph data structures
interface GraphNode {
  id: string;
  type: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  tags?: Record<string, string>;
  properties?: any;
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
  properties?: any;
}

interface TopologyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Cache for topology data
let topologyCache: TopologyGraph | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Azure Resource Graph queries
const RESOURCE_QUERY = `
resources
| where subscriptionId in~ (${subscriptionIds.map((id: string) => `'${id}'`).join(',')})
| project id, type, name, subscriptionId, resourceGroup, location, tags, properties
| order by name asc
`;

const NETWORK_RESOURCES_QUERY = `
resources
| where subscriptionId in~ (${subscriptionIds.map((id: string) => `'${id}'`).join(',')})
| where type in~ (
    'microsoft.network/virtualnetworks',
    'microsoft.network/subnets',
    'microsoft.network/networkinterfaces',
    'microsoft.network/publicipaddresses',
    'microsoft.network/loadbalancers',
    'microsoft.network/applicationgateways',
    'microsoft.network/networksecuritygroups'
)
| project id, type, name, subscriptionId, resourceGroup, location, tags, properties
| order by name asc
`;

// Build topology from Azure resources
async function buildTopology(): Promise<TopologyGraph> {
  const now = Date.now();
  if (topologyCache && (now - cacheTimestamp) < CACHE_TTL) {
    return topologyCache;
  }

  console.error('Building topology from Azure resources...');
  
  try {
    // Query all resources
    const resourcesResult = await resourceGraphClient.resources({
      query: RESOURCE_QUERY,
      subscriptions: subscriptionIds,
    });

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Process resources into nodes
    if (resourcesResult.data) {
      for (const resource of resourcesResult.data as any[]) {
        const node: GraphNode = {
          id: resource.id,
          type: resource.type,
          name: resource.name,
          subscriptionId: resource.subscriptionId,
          resourceGroup: resource.resourceGroup,
          location: resource.location,
          tags: resource.tags,
          properties: resource.properties,
        };
        nodes.push(node);
      }
    }

    // Build relationships/edges
    await buildResourceRelationships(nodes, edges);

    const topology: TopologyGraph = { nodes, edges };
    topologyCache = topology;
    cacheTimestamp = now;
    
    console.error(`Topology built: ${nodes.length} nodes, ${edges.length} edges`);
    return topology;
  } catch (error) {
    console.error('Error building topology:', error);
    throw error;
  }
}

// Build relationships between resources
async function buildResourceRelationships(nodes: GraphNode[], edges: GraphEdge[]) {
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  
  for (const node of nodes) {
    // Resource Group relationships
    const rgNodes = nodes.filter(n => n.resourceGroup === node.resourceGroup && n.id !== node.id);
    for (const rgNode of rgNodes) {
      if (!edges.some(e => e.source === node.id && e.target === rgNode.id && e.type === 'resource-group')) {
        edges.push({
          source: node.id,
          target: rgNode.id,
          type: 'resource-group',
        });
      }
    }

    // Network relationships
    if (node.type === 'microsoft.compute/virtualmachines') {
      await buildVMNetworkRelationships(node, nodes, edges);
    } else if (node.type === 'microsoft.network/virtualnetworks') {
      await buildVNetRelationships(node, nodes, edges);
    }
  }
}

// Build VM network relationships
async function buildVMNetworkRelationships(vmNode: GraphNode, nodes: GraphNode[], edges: GraphEdge[]) {
  try {
    if (vmNode.properties?.networkProfile?.networkInterfaces) {
      for (const nicRef of vmNode.properties.networkProfile.networkInterfaces) {
        const nicNode = nodes.find(n => n.id === nicRef.id);
        if (nicNode) {
          edges.push({
            source: vmNode.id,
            target: nicNode.id,
            type: 'network-interface',
          });
        }
      }
    }
  } catch (error) {
    console.error(`Error building VM network relationships for ${vmNode.name}:`, error);
  }
}

// Build VNet relationships
async function buildVNetRelationships(vnetNode: GraphNode, nodes: GraphNode[], edges: GraphEdge[]) {
  try {
    // Find subnets in the same resource group
    const subnets = nodes.filter(n => 
      n.type === 'microsoft.network/virtualnetworks/subnets' &&
      n.resourceGroup === vnetNode.resourceGroup &&
      n.id.startsWith(vnetNode.id)
    );
    
    for (const subnet of subnets) {
      edges.push({
        source: vnetNode.id,
        target: subnet.id,
        type: 'subnet',
      });
    }
  } catch (error) {
    console.error(`Error building VNet relationships for ${vnetNode.name}:`, error);
  }
}

// Search resources by query
async function searchResources(query: string, resourceType?: string): Promise<GraphNode[]> {
  const topology = await buildTopology();
  const searchLower = query.toLowerCase();
  
  return topology.nodes.filter(node => {
    const matchesQuery = 
      node.name.toLowerCase().includes(searchLower) ||
      node.type.toLowerCase().includes(searchLower) ||
      node.resourceGroup.toLowerCase().includes(searchLower) ||
      node.location.toLowerCase().includes(searchLower) ||
      (node.tags && Object.values(node.tags).some(tag => 
        tag.toLowerCase().includes(searchLower)
      ));
    
    const matchesType = !resourceType || node.type.toLowerCase().includes(resourceType.toLowerCase());
    
    return matchesQuery && matchesType;
  });
}

// Get resource neighbors
async function getResourceNeighbors(resourceId: string): Promise<{node: GraphNode, neighbors: GraphNode[]}> {
  const topology = await buildTopology();
  const node = topology.nodes.find(n => n.id === resourceId);
  
  if (!node) {
    throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${resourceId}`);
  }
  
  // Find all connected nodes
  const connectedIds = new Set<string>();
  
  for (const edge of topology.edges) {
    if (edge.source === resourceId) {
      connectedIds.add(edge.target);
    } else if (edge.target === resourceId) {
      connectedIds.add(edge.source);
    }
  }
  
  const neighbors = topology.nodes.filter(n => connectedIds.has(n.id));
  
  return { node, neighbors };
}

// Find path between resources
async function findResourcePath(sourceId: string, targetId: string): Promise<GraphNode[]> {
  const topology = await buildTopology();
  
  if (!topology.nodes.find(n => n.id === sourceId)) {
    throw new McpError(ErrorCode.InvalidRequest, `Source resource not found: ${sourceId}`);
  }
  
  if (!topology.nodes.find(n => n.id === targetId)) {
    throw new McpError(ErrorCode.InvalidRequest, `Target resource not found: ${targetId}`);
  }
  
  // Simple BFS to find shortest path
  const queue: string[][] = [[sourceId]];
  const visited = new Set<string>([sourceId]);
  
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    
    if (current === targetId) {
      return path.map(id => topology.nodes.find(n => n.id === id)!);
    }
    
    // Find neighbors
    for (const edge of topology.edges) {
      let next: string | null = null;
      
      if (edge.source === current && !visited.has(edge.target)) {
        next = edge.target;
      } else if (edge.target === current && !visited.has(edge.source)) {
        next = edge.source;
      }
      
      if (next) {
        visited.add(next);
        queue.push([...path, next]);
      }
    }
  }
  
  return []; // No path found
}

// Create MCP server
const server = new Server(
  {
    name: 'azure-topology-graph',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_resources',
        description: 'Search Azure resources by name, type, or other properties',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (searches name, type, resource group, location, tags)',
            },
            resourceType: {
              type: 'string',
              description: 'Optional filter by resource type',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_resource',
        description: 'Get detailed information about a specific Azure resource',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: {
              type: 'string',
              description: 'Full Azure resource ID',
            },
          },
          required: ['resourceId'],
        },
      },
      {
        name: 'get_neighbors',
        description: 'Get resources connected to a specific resource',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: {
              type: 'string',
              description: 'Full Azure resource ID',
            },
          },
          required: ['resourceId'],
        },
      },
      {
        name: 'find_path',
        description: 'Find connection path between two Azure resources',
        inputSchema: {
          type: 'object',
          properties: {
            sourceId: {
              type: 'string',
              description: 'Source resource ID',
            },
            targetId: {
              type: 'string',
              description: 'Target resource ID',
            },
          },
          required: ['sourceId', 'targetId'],
        },
      },
      {
        name: 'export_topology',
        description: 'Export the complete topology graph',
        inputSchema: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['json', 'summary'],
              description: 'Export format',
              default: 'summary',
            },
          },
        },
      },
      {
        name: 'refresh_topology',
        description: 'Refresh the topology cache by re-querying Azure',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search_resources': {
        const { query, resourceType } = args as { query: string; resourceType?: string };
        const results = await searchResources(query, resourceType);
        return {
          content: [
            {
              type: 'text',
              text: `Found ${results.length} resources matching "${query}":\n\n` +
                results.map(r => 
                  `• ${r.name} (${r.type})\n  Resource Group: ${r.resourceGroup}\n  Location: ${r.location}\n  ID: ${r.id}`
                ).join('\n\n'),
            },
          ],
        };
      }

      case 'get_resource': {
        const { resourceId } = args as { resourceId: string };
        const topology = await buildTopology();
        const resource = topology.nodes.find(n => n.id === resourceId);
        
        if (!resource) {
          throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${resourceId}`);
        }
        
        return {
          content: [
            {
              type: 'text',
              text: `Resource Details:\n\n` +
                `Name: ${resource.name}\n` +
                `Type: ${resource.type}\n` +
                `Resource Group: ${resource.resourceGroup}\n` +
                `Location: ${resource.location}\n` +
                `Subscription: ${resource.subscriptionId}\n` +
                `ID: ${resource.id}\n\n` +
                (resource.tags ? `Tags: ${JSON.stringify(resource.tags, null, 2)}\n\n` : '') +
                (resource.properties ? `Properties: ${JSON.stringify(resource.properties, null, 2)}` : ''),
            },
          ],
        };
      }

      case 'get_neighbors': {
        const { resourceId } = args as { resourceId: string };
        const { node, neighbors } = await getResourceNeighbors(resourceId);
        
        return {
          content: [
            {
              type: 'text',
              text: `Resource: ${node.name} (${node.type})\n\n` +
                `Connected Resources (${neighbors.length}):\n\n` +
                neighbors.map(n => 
                  `• ${n.name} (${n.type})\n  Resource Group: ${n.resourceGroup}\n  Location: ${n.location}`
                ).join('\n\n'),
            },
          ],
        };
      }

      case 'find_path': {
        const { sourceId, targetId } = args as { sourceId: string; targetId: string };
        const path = await findResourcePath(sourceId, targetId);
        
        if (path.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No connection path found between the specified resources.`,
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: 'text',
              text: `Connection Path (${path.length} hops):\n\n` +
                path.map((node, index) => 
                  `${index + 1}. ${node.name} (${node.type})\n   ${node.id}`
                ).join('\n\n'),
            },
          ],
        };
      }

      case 'export_topology': {
        const { format = 'summary' } = args as { format?: 'json' | 'summary' };
        const topology = await buildTopology();
        
        if (format === 'json') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(topology, null, 2),
              },
            ],
          };
        } else {
          const resourceTypes = Array.from(new Set(topology.nodes.map(n => n.type))).sort();
          const subscriptions = Array.from(new Set(topology.nodes.map(n => n.subscriptionId))).sort();
          const resourceGroups = Array.from(new Set(topology.nodes.map(n => n.resourceGroup))).sort();
          
          return {
            content: [
              {
                type: 'text',
                text: `Azure Topology Summary:\n\n` +
                  `Total Resources: ${topology.nodes.length}\n` +
                  `Total Connections: ${topology.edges.length}\n\n` +
                  `Subscriptions (${subscriptions.length}):\n${subscriptions.map(s => `• ${s}`).join('\n')}\n\n` +
                  `Resource Groups (${resourceGroups.length}):\n${resourceGroups.map(rg => `• ${rg}`).join('\n')}\n\n` +
                  `Resource Types (${resourceTypes.length}):\n${resourceTypes.map(rt => `• ${rt}`).join('\n')}`,
              },
            ],
          };
        }
      }

      case 'refresh_topology': {
        topologyCache = null;
        cacheTimestamp = 0;
        const topology = await buildTopology();
        
        return {
          content: [
            {
              type: 'text',
              text: `Topology refreshed successfully.\n\n` +
                `Resources: ${topology.nodes.length}\n` +
                `Connections: ${topology.edges.length}`,
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${errorMessage}`);
  }
});

// Start the server
async function main() {
  try {
    await initializeClients();
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Azure Topology Graph MCP Server started successfully');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
