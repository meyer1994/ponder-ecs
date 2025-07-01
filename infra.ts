import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export class EcsInfrastructureStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC
        const vpc = new ec2.Vpc(this, 'EcsVpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        // Create ECS Cluster
        const cluster = new ecs.Cluster(this, 'EcsCluster', {
            vpc,
            clusterName: 'ponder-cluster',
        });

        // Security Group for PostgreSQL
        const postgresSecurityGroup = new ec2.SecurityGroup(this, 'PostgresSecurityGroup', {
            vpc,
            description: 'Security group for PostgreSQL service',
            allowAllOutbound: true,
        });

        // Security Group for Application
        const appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
            vpc,
            description: 'Security group for application service',
            allowAllOutbound: true,
        });

        // Allow app to connect to postgres on port 5432
        postgresSecurityGroup.addIngressRule(
            appSecurityGroup,
            ec2.Port.tcp(5432),
            'Allow app to connect to PostgreSQL'
        );

        // Allow ALB to connect to app
        appSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(3000),
            'Allow ALB to connect to app'
        );

        // CloudWatch Log Groups
        const postgresLogGroup = new logs.LogGroup(this, 'PostgresLogGroup', {
            logGroupName: '/ecs/postgres',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
            logGroupName: '/ecs/app',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // PostgreSQL Task Definition
        const postgresTaskDefinition = new ecs.FargateTaskDefinition(this, 'PostgresTaskDefinition', {
            memoryLimitMiB: 1024,
            cpu: 512,
        });

        const postgresContainer = postgresTaskDefinition.addContainer('postgres', {
            image: ecs.ContainerImage.fromRegistry('postgres:15-alpine'),
            environment: {
                POSTGRES_DB: 'ponder',
                POSTGRES_USER: 'ponder',
                POSTGRES_PASSWORD: 'ponder123', // In production, use Secrets Manager
            },
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'postgres',
                logGroup: postgresLogGroup,
            }),
            healthCheck: {
                command: ['CMD-SHELL', 'pg_isready -U ponder'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
            },
        });

        postgresContainer.addPortMappings({
            containerPort: 5432,
            protocol: ecs.Protocol.TCP,
        });

        // PostgreSQL Service
        const postgresService = new ecs.FargateService(this, 'PostgresService', {
            cluster,
            taskDefinition: postgresTaskDefinition,
            desiredCount: 1,
            serviceName: 'postgres-service',
            securityGroups: [postgresSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            enableServiceConnect: true,
        });

        // Application Task Definition
        const appTaskDefinition = new ecs.FargateTaskDefinition(this, 'AppTaskDefinition', {
            memoryLimitMiB: 512,
            cpu: 256,
        });

        const appContainer = appTaskDefinition.addContainer('app', {
            image: ecs.ContainerImage.fromRegistry('nginx:alpine'), // Placeholder image
            environment: {
                NODE_ENV: 'production',
                DATABASE_URL: 'postgresql://ponder:ponder123@postgres-service:5432/ponder',
            },
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'app',
                logGroup: appLogGroup,
            }),
            healthCheck: {
                command: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:3000/health', '||', 'exit', '1'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
            },
        });

        appContainer.addPortMappings({
            containerPort: 3000,
            protocol: ecs.Protocol.TCP,
        });

        // Application Service
        const appService = new ecs.FargateService(this, 'AppService', {
            cluster,
            taskDefinition: appTaskDefinition,
            desiredCount: 2,
            serviceName: 'app-service',
            securityGroups: [appSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
        });

        // Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, 'AppLoadBalancer', {
            vpc,
            internetFacing: true,
            loadBalancerName: 'ponder-alb',
        });

        const listener = alb.addListener('Listener', {
            port: 80,
            open: true,
        });

        const targetGroup = listener.addTargets('AppTargets', {
            port: 3000,
            targets: [appService],
            healthCheck: {
                path: '/health',
                interval: cdk.Duration.seconds(60),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
            },
        });

        // Service Discovery for internal communication
        const serviceDiscoveryNamespace = cluster.addDefaultCloudMapNamespace({
            name: 'ponder.local',
        });

        postgresService.enableCloudMap({
            name: 'postgres',
            cloudMapNamespace: serviceDiscoveryNamespace,
        });

        // Outputs
        new cdk.CfnOutput(this, 'LoadBalancerURL', {
            value: `http://${alb.loadBalancerDnsName}`,
            description: 'URL of the Application Load Balancer',
        });

        new cdk.CfnOutput(this, 'VpcId', {
            value: vpc.vpcId,
            description: 'VPC ID',
        });

        new cdk.CfnOutput(this, 'ClusterName', {
            value: cluster.clusterName,
            description: 'ECS Cluster Name',
        });
    }
}

// App instantiation
const app = new cdk.App();
new EcsInfrastructureStack(app, 'PonderEcsInfrastructureStack', {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
});
