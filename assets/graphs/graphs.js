
var colors = ["rgba(230,140,35,0.8)", "rgba(130,20,0,0.8)"]

function makeBarChart(id, xLabel, yLabel, dataLabels, data) {   
    var ctx = document.getElementById(id).getContext('2d');
    var datasets = [];
    var colorIndex = 0;
    for (var series in data) {        
        datasets.push({
            label: series,
            backgroundColor: colors[colorIndex],        
            barPercentage: 0.6,
            data: data[series],
        });
        colorIndex++;
    }

    new Chart(ctx, {
        type: 'horizontalBar',
        data: {
            labels: dataLabels,
            datasets: datasets,
        },
        options: {
            maintainAspectRatio: false,
            legend: { display: Object.keys(data).length  > 1 },
            scales: {
                yAxes: [{
                    scaleLabel: { 
                        display: true,
                        labelString: yLabel,
                    },
                }],
                xAxes: [{
                    scaleLabel: { 
                        display: true,
                        labelString: xLabel,
                    },
                    ticks: {
                        beginAtZero: true
                    }
                }]
            }    
        }
    });
}    

function makeBarChartDeferred(id, xLabel, yLabel, dataLabels, data) {
    document.addEventListener('readystatechange', event => {
        if (event.target.readyState === "complete") {
            makeBarChart(id, xLabel, yLabel, dataLabels, data);
        }
    });      
}

